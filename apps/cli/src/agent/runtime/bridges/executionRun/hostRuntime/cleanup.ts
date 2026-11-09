import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { wrapExecutionRunHostRuntime } from './wrap';

export function withExecutionRunHostRuntimeCleanup(
    runtime: ExecutionRunHostRuntime,
    cleanup: () => Promise<void> | void,
): ExecutionRunHostRuntime {
    return wrapExecutionRunHostRuntime({
        readPermissionCapability: () => runtime.permissionCapability,
        readInteraction: () => runtime.interaction,
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
        readRespondToPermission: () => runtime.permissionCapability === 'responds'
            ? runtime.respondToPermission
            : undefined,
        readAbortPendingPermissionRequests: () => runtime.abortPendingPermissionRequests?.bind(runtime),
        readWaitForTurnCompletion: () => runtime.waitForTurnCompletion,
        readProbeTurnLiveness: () => runtime.probeTurnLiveness,
        async dispose() {
            try {
                await runtime.dispose();
            } finally {
                await cleanup();
            }
        },
    });
}
