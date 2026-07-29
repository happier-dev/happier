import type { TimeoutBudgetV1, TimeoutRuntimeServiceV1 } from '@happier-dev/plugin-sdk/experimental/timeout';

import { createPluginAbortService } from './abort';

export function createPluginTimeoutService(): TimeoutRuntimeServiceV1 {
    async function withMs<T>(
        timeoutMs: number,
        operation: (signal: AbortSignal) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
            const controller = new AbortController();
            const abort = createPluginAbortService({ controller });
            const timeout = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
            const composedSignal = signal ? abort.service.compose([signal]) : controller.signal;
            try {
                return await abort.service.race(operation(composedSignal), composedSignal);
            } finally {
                clearTimeout(timeout);
            }
    }

    const service: TimeoutRuntimeServiceV1 = Object.freeze({
        withMs,
        async withBudget<T>(
            budget: TimeoutBudgetV1,
            operation: (signal: AbortSignal) => Promise<T>,
            signal?: AbortSignal,
        ): Promise<T> {
            const elapsedMs = Date.now() - budget.startedAtMs;
            return await withMs(Math.max(0, budget.timeoutMs - elapsedMs), operation, signal);
        },
    });
    return service;
}
