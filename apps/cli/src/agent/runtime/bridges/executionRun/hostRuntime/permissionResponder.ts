import { toRuntimePermissionResponseOutcome, type ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { ExecutionRunPermissionResponder } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { wrapExecutionRunHostRuntime } from './wrap';

type PermissionHandlerResponder = Readonly<{
  respondToPermissionRequest?: ExecutionRunPermissionResponder;
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
    readInteraction: () => runtime.interaction,
    readExecuteAction: () => runtime.executeAction?.bind(runtime),
    readToolNormalizationSource: () => runtime.toolNormalizationSource,
    readResumeSupport: (opts) => runtime.readResumeSupport(opts),
    readPrepareInputBudget: () => runtime.prepareInputBudget?.bind(runtime),
    readModelContextWindowTokens: () => runtime.readModelContextWindowTokens?.bind(runtime),
    readProviderSessionId: () => runtime.readProviderSessionId?.bind(runtime),
    readCanContinueAfterCancellation: () => runtime.canContinueAfterCancellation?.bind(runtime),
    provisionRuntime: (opts) => runtime.provisionRuntime(opts),
    deliverInput: (runtimeId, input, context) => runtime.deliverInput(runtimeId, input, context),
    readSteerInput: () => runtime.steerInput?.bind(runtime),
    getRuntimeLifetimeSignal: () => runtime.getRuntimeLifetimeSignal(),
    readSubscribeProviderInputOutcomes: () => runtime.subscribeProviderInputOutcomes?.bind(runtime),
    readSubscribeRuntimeEvents: () => runtime.subscribeRuntimeEvents?.bind(runtime),
    readActiveTurnAdmissionWitness: () => runtime.readActiveTurnAdmissionWitness?.bind(runtime),
    cancel: (runtimeId) => runtime.cancel(runtimeId),
    subscribeMessages: (handler) => runtime.subscribeMessages(handler),
    readRespondToPermission: () => async (requestId, approved, response) =>
      toRuntimePermissionResponseOutcome(await responder(requestId, response ?? approved)),
    readAbortPendingPermissionRequests: () => runtime.abortPendingPermissionRequests?.bind(runtime),
    readWaitForTurnCompletion: () => runtime.waitForTurnCompletion,
    readProbeTurnLiveness: () => runtime.probeTurnLiveness,
    dispose: () => runtime.dispose(),
  });
}
