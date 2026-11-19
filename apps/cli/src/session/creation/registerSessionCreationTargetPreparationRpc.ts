import { SessionCreationTargetPreparationRequestV1Schema, needsSessionCreationDirectoryApprovalPreflightV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { projectAgentIsolationLaunchRefusal } from '@/daemon/agentIsolation/agentIsolationLaunchRefusal';
import { createFilesystemEffectRpcRegistrar, type FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

import { prepareSessionCreationTarget } from './prepareSessionCreationTarget';
import type { DirectoryPreflightRefusal } from './directoryPreflightDiagnostic';

type PrepareSessionCreationTarget = typeof prepareSessionCreationTarget;

type TargetPreparationRpcInput = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  prepare?: PrepareSessionCreationTarget;
  onDirectoryPreflightRefused?: (diagnostic: DirectoryPreflightRefusal) => void;
}>;

function createPreparationHandler(input: TargetPreparationRpcInput, readOnly: boolean) {
  const prepare = input.prepare ?? prepareSessionCreationTarget;
  return async (rawRequest: unknown, context: RpcHandlerContext | undefined): Promise<SessionCreationTargetPreparationResultV1> => {
    if (!context) {
      throw new Error('Session creation target preparation requires an RPC cancellation context');
    }
    const request = SessionCreationTargetPreparationRequestV1Schema.parse(rawRequest);
    // This method is read-only for every caller. The original materializing
    // method keeps its custodian-only admission, including on older guests.
    if (readOnly && !needsSessionCreationDirectoryApprovalPreflightV1(request)) {
      throw createRpcCallError({ error: 'Directory preflight is read-only', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    return await prepare({ request, signal: context.signal,
      ...(input.onDirectoryPreflightRefused ? { onDirectoryPreflightRefused: input.onDirectoryPreflightRefused } : {}) });
  };
}

/** The native filesystem worker registers only the already-admitted read. */
export function registerSessionCreationDirectoryPreflightRpc(input: TargetPreparationRpcInput): void {
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
    createPreparationHandler(input, true));
}

/** Requester preparation for the native folder read runs in the filesystem
 * admission, outside the preparation handler. Its isolation refusal settles as
 * a typed preparation result so the caller keeps the reason and Security
 * remedy; a PluginError RPC reply carries only its code. */
function settleAgentIsolationRefusal(registrar: RpcHandlerRegistrar): RpcHandlerRegistrar {
  return { registerHandler(method, handler) {
    registrar.registerHandler(method, async (request, context) => {
      try { return await handler(request, context); } catch (error) {
        const launchError = projectAgentIsolationLaunchRefusal(error);
        if (!launchError) throw error;
        return { ok: false, code: 'agent_isolation_unavailable', launchError } satisfies SessionCreationTargetPreparationResultV1;
      }
    });
  } };
}

export function registerSessionCreationTargetPreparationRpc(input: TargetPreparationRpcInput & Readonly<{
  directoryPreflightAdmission?: FilesystemEffectAdmission;
}>): void {
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
    createPreparationHandler(input, false));
  registerSessionCreationDirectoryPreflightRpc({ ...input,
    rpcHandlerManager: input.directoryPreflightAdmission
      ? createFilesystemEffectRpcRegistrar(settleAgentIsolationRefusal(input.rpcHandlerManager), input.directoryPreflightAdmission)
      : input.rpcHandlerManager });
}
