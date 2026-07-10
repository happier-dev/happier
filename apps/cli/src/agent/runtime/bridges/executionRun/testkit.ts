import type {
    ExecutionRunHostRuntime,
    ExecutionRunHostRuntimeMessageHandler,
    ExecutionRunPermissionCapability,
    RuntimePermissionResponseOutcome,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import type { AgentMessage } from '@/agent/core/AgentMessage';

export type TestExecutionRunHostRuntime = ExecutionRunHostRuntime & Readonly<{
    emitMessage: (message: AgentMessage) => void;
}>;

type PromptMeta = Parameters<ExecutionRunHostRuntime['sendPrompt']>[2];

export type TestExecutionRunHostRuntimeOptions = Readonly<{
    sessionId?: string;
    resumeSessionId?: string;
    resumeSupported?: boolean;
    replayResumeSupported?: boolean;
    permissionCapability?: ExecutionRunPermissionCapability;
    onProvisionSession?: (opts: Parameters<ExecutionRunHostRuntime['provisionSession']>[0]) => void | Promise<void>;
    onSendPrompt?: (
        sessionId: string,
        prompt: string,
        meta?: PromptMeta,
    ) => void | Promise<void>;
    onSendSteerPrompt?: (
        sessionId: string,
        prompt: string,
        meta?: PromptMeta,
    ) => void | Promise<void>;
    onCancel?: (sessionId: string) => void | Promise<void>;
    onRespondToPermission?: (requestId: string, approved: boolean) => RuntimePermissionResponseOutcome | Promise<RuntimePermissionResponseOutcome>;
    onWaitForTurnCompletion?: (timeoutMs?: number | null) => void | Promise<void>;
    onDispose?: () => void | Promise<void>;
}>;

export function createTestExecutionRunHostRuntime(
    opts: TestExecutionRunHostRuntimeOptions = {},
): TestExecutionRunHostRuntime {
    const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
    const sessionId = opts.sessionId ?? 'child_session_1';
    const runtime = {
        permissionCapability: opts.permissionCapability ?? (opts.onRespondToPermission ? 'responds' : 'static'),
        async readResumeSupport(readOpts) {
            if (readOpts?.captureReplay === true) {
                return opts.replayResumeSupported ?? false;
            }
            return opts.resumeSupported ?? opts.replayResumeSupported ?? false;
        },
        async provisionSession(provisionOpts) {
            await opts.onProvisionSession?.(provisionOpts);
            return { sessionId: provisionOpts?.resumeSessionId ?? opts.resumeSessionId ?? sessionId };
        },
        async sendPrompt(activeSessionId, prompt, meta) {
            await opts.onSendPrompt?.(activeSessionId, prompt, meta);
        },
        ...(opts.onSendSteerPrompt
            ? {
                async sendSteerPrompt(
                    activeSessionId: string,
                    prompt: string,
                    meta?: PromptMeta,
                ) {
                    await opts.onSendSteerPrompt!(activeSessionId, prompt, meta);
                },
            }
            : {}),
        async cancel(activeSessionId) {
            await opts.onCancel?.(activeSessionId);
        },
        subscribeMessages(handler) {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        ...(opts.onRespondToPermission
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return await opts.onRespondToPermission!(requestId, approved);
                },
            }
            : {}),
        ...(opts.onWaitForTurnCompletion
            ? {
                async waitForTurnCompletion(timeoutMs?: number | null) {
                    await opts.onWaitForTurnCompletion!(timeoutMs);
                },
            }
            : {}),
        async dispose() {
            handlers.clear();
            await opts.onDispose?.();
        },
        emitMessage(message) {
            for (const handler of handlers) {
                handler(message);
            }
        },
    } satisfies TestExecutionRunHostRuntime;
    return Object.freeze(runtime);
}
