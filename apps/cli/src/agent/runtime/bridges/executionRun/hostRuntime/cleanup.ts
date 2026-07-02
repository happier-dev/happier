import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

export function withExecutionRunHostRuntimeCleanup(
    runtime: ExecutionRunHostRuntime,
    cleanup: () => Promise<void> | void,
): ExecutionRunHostRuntime {
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
        ...(typeof runtime.respondToPermission === 'function'
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    await runtime.respondToPermission!(requestId, approved);
                },
            }
            : {}),
        ...(typeof runtime.waitForTurnCompletion === 'function'
            ? {
                async waitForTurnCompletion(timeoutMs?: number | null) {
                    await runtime.waitForTurnCompletion!(timeoutMs);
                },
            }
            : {}),
        async dispose() {
            try {
                await runtime.dispose();
            } finally {
                await cleanup();
            }
        },
    });
}
