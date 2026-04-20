import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

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

  return Object.freeze({
    async readResumeSupport(opts) {
      return await runtime.readResumeSupport(opts);
    },
    async provisionSession(opts) {
      return await runtime.provisionSession(opts);
    },
    async sendPrompt(sessionId, prompt) {
      await runtime.sendPrompt(sessionId, prompt);
    },
    ...(typeof runtime.sendSteerPrompt === 'function'
      ? {
          async sendSteerPrompt(sessionId: string, prompt: string) {
            await runtime.sendSteerPrompt!(sessionId, prompt);
          },
        }
      : {}),
    async cancel(sessionId) {
      await runtime.cancel(sessionId);
    },
    subscribeMessages(handler) {
      return runtime.subscribeMessages(handler);
    },
    async respondToPermission(requestId: string, approved: boolean) {
      responder(requestId, approved);
    },
    ...(typeof runtime.waitForTurnCompletion === 'function'
      ? {
          async waitForTurnCompletion(timeoutMs?: number | null) {
            await runtime.waitForTurnCompletion!(timeoutMs);
          },
        }
      : {}),
    async dispose() {
      await runtime.dispose();
    },
  });
}
