import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { createExecutionRunCodedError } from '../errors';
import { wrapExecutionRunHostRuntime } from './wrap';

/** The child owns a turn and its observers; the retained controller owns the native runtime. */
export function borrowExecutionRunRuntimeTurn(
    runtime: ExecutionRunHostRuntime,
    runtimeId: string,
    isCurrent: () => boolean,
    authorizeInput: () => Promise<void>,
): ExecutionRunHostRuntime {
    const subscriptions = new Set<() => void>();
    const assertCurrent = () => {
        if (!isCurrent()) throw createExecutionRunCodedError('execution_run_not_allowed', 'The retained reviewer is unavailable');
    };
    return wrapExecutionRunHostRuntime({
        readPermissionCapability: () => runtime.permissionCapability,
        readInteraction: () => runtime.interaction,
        readResumeSupport: opts => runtime.readResumeSupport(opts),
        readPrepareInputBudget: () => runtime.prepareInputBudget ? async () => {
            assertCurrent();
            const budget = await runtime.prepareInputBudget!();
            assertCurrent();
            return budget;
        } : undefined,
        readProviderSessionId: () => runtime.readProviderSessionId?.bind(runtime),
        readModelContextWindowTokens: () => runtime.readModelContextWindowTokens?.bind(runtime),
        readCanContinueAfterCancellation: () => runtime.canContinueAfterCancellation?.bind(runtime),
        async provisionRuntime() {
            assertCurrent();
            return { runtimeId };
        },
        async deliverInput(_runtimeId, input, context) {
            assertCurrent();
            await authorizeInput();
            assertCurrent();
            return await runtime.deliverInput(runtimeId, input, context);
        },
        readSteerInput: () => runtime.steerInput ? async (_runtimeId, input, context) => {
            assertCurrent();
            await authorizeInput();
            assertCurrent();
            return await runtime.steerInput!(runtimeId, input, context);
        } : undefined,
        getRuntimeLifetimeSignal: () => runtime.getRuntimeLifetimeSignal(),
        readSubscribeProviderInputOutcomes: () => runtime.subscribeProviderInputOutcomes?.bind(runtime),
        readSubscribeRuntimeEvents: () => runtime.subscribeRuntimeEvents?.bind(runtime),
        readActiveTurnAdmissionWitness: () => runtime.readActiveTurnAdmissionWitness?.bind(runtime),
        async cancel() {
            if (isCurrent()) await runtime.cancel(runtimeId);
        },
        subscribeMessages(handler) {
            const unsubscribe = runtime.subscribeMessages(message => {
                if (isCurrent()) handler(message);
            });
            subscriptions.add(unsubscribe);
            return () => { subscriptions.delete(unsubscribe); unsubscribe(); };
        },
        readRespondToPermission: () => runtime.respondToPermission?.bind(runtime),
        readAbortPendingPermissionRequests: () => async reason => {
            if (isCurrent()) await runtime.abortPendingPermissionRequests?.(reason);
        },
        readWaitForTurnCompletion: () => runtime.waitForTurnCompletion?.bind(runtime),
        readProbeTurnLiveness: () => runtime.probeTurnLiveness?.bind(runtime),
        async dispose() {
            for (const unsubscribe of subscriptions) unsubscribe();
            subscriptions.clear();
        },
    });
}
