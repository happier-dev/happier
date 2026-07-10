import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { wrapExecutionRunHostRuntime } from './wrap';

export function withExecutionRunHostRuntimeCleanup(
    runtime: ExecutionRunHostRuntime,
    cleanup: () => Promise<void> | void,
): ExecutionRunHostRuntime {
    return wrapExecutionRunHostRuntime({
        readPermissionCapability: () => runtime.permissionCapability,
        readResumeSupport: (opts) => runtime.readResumeSupport(opts),
        provisionSession: (opts) => runtime.provisionSession(opts),
        sendPrompt: (sessionId, prompt, meta) => runtime.sendPrompt(sessionId, prompt, meta),
        readSendSteerPrompt: () => runtime.sendSteerPrompt,
        cancel: (sessionId) => runtime.cancel(sessionId),
        subscribeMessages: (handler) => runtime.subscribeMessages(handler),
        readRespondToPermission: () => runtime.permissionCapability === 'responds'
            ? runtime.respondToPermission
            : undefined,
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
