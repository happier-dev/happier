import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { wrapExecutionRunHostRuntime } from './wrap';

type PermissionHandlerResponder = Readonly<{
  respondToPermissionRequest?: (requestId: string, approved: boolean) => void;
}>;

/**
 * Execution-run runtimes surface permission prompts as ACP messages. For execution runs, the
 * "UI response" arrives via ExecutionRunHostBridge.respondToPermissionRequest (action plumbing),
 * not via the session RPC channel used by normal sessions.
 *
 * This wrapper wires ExecutionRunHostRuntime.respondToPermission(...) into the injected ACP
 * permission handler's responder (when available), so permission gating can block until the
 * host/UI responds and we never "fail open" by auto-approving.
 */
export function withExecutionRunPermissionResponder(
  runtime: ExecutionRunHostRuntime,
  permissionHandler: unknown,
): ExecutionRunHostRuntime {
  const responder =
    (permissionHandler as PermissionHandlerResponder | null | undefined)?.respondToPermissionRequest ?? null;
  if (typeof responder !== 'function') {
    return runtime;
  }

  return wrapExecutionRunHostRuntime({
    readPermissionCapability: () => 'responds',
    readResumeSupport: (opts) => runtime.readResumeSupport(opts),
    provisionSession: (opts) => runtime.provisionSession(opts),
    sendPrompt: (sessionId, prompt, meta) => runtime.sendPrompt(sessionId, prompt, meta),
    readSendSteerPrompt: () => runtime.sendSteerPrompt,
    cancel: (sessionId) => runtime.cancel(sessionId),
    subscribeMessages: (handler) => runtime.subscribeMessages(handler),
    readRespondToPermission: () => async (requestId: string, approved: boolean) => {
      responder(requestId, approved);
      return { delivered: true as const };
    },
    readWaitForTurnCompletion: () => runtime.waitForTurnCompletion,
    readProbeTurnLiveness: () => runtime.probeTurnLiveness,
    dispose: () => runtime.dispose(),
  });
}
