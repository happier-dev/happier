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

type PromptMeta = Parameters<ExecutionRunHostRuntime['deliverInput']>[2];

export type TestExecutionRunHostRuntimeOptions = Readonly<{
    runtimeId?: string;
    /** Explicit vendor identity, independent of this fixture's dispatch id. */
    providerSessionId?: string;
    resumeRuntimeId?: string;
    resumeSupported?: boolean;
    replayResumeSupported?: boolean;
    permissionCapability?: ExecutionRunPermissionCapability;
    onProvisionRuntime?: (opts: Parameters<ExecutionRunHostRuntime['provisionRuntime']>[0]) => void | Promise<void>;
    onSendPrompt?: (
        runtimeId: string,
        prompt: string,
        meta?: PromptMeta,
    ) => void | Promise<void>;
    onSendSteerPrompt?: (
        runtimeId: string,
        prompt: string,
        meta?: PromptMeta,
    ) => void | Promise<void>;
    onCancel?: (runtimeId: string) => void | Promise<void>;
    onRespondToPermission?: (requestId: string, approved: boolean, response?: import('@/agent/permissions/BasePermissionHandler').PermissionResult) => RuntimePermissionResponseOutcome | Promise<RuntimePermissionResponseOutcome>;
    onWaitForTurnCompletion?: (timeoutMs?: number | null) => void | Promise<void>;
    onDispose?: () => void | Promise<void>;
}>;

export function createTestExecutionRunHostRuntime(
    opts: TestExecutionRunHostRuntimeOptions = {},
): TestExecutionRunHostRuntime {
    const handlers = new Set<ExecutionRunHostRuntimeMessageHandler>();
    const runtimeId = opts.runtimeId ?? 'child_runtime_1';
    const lifetime = new AbortController();
    const runtime = {
        permissionCapability: opts.permissionCapability ?? (opts.onRespondToPermission ? 'responds' : 'static'),
        async readResumeSupport(readOpts) {
            if (readOpts?.captureReplay === true) {
                return opts.replayResumeSupported ?? false;
            }
            return opts.resumeSupported ?? opts.replayResumeSupported ?? false;
        },
        readProviderSessionId: () => opts.providerSessionId ?? null,
        async provisionRuntime(provisionOpts) {
            await opts.onProvisionRuntime?.(provisionOpts);
            return { runtimeId: provisionOpts?.resumeRuntimeId ?? opts.resumeRuntimeId ?? runtimeId };
        },
        getRuntimeLifetimeSignal: () => lifetime.signal,
        async deliverInput(activeRuntimeId, input, meta) {
            await opts.onSendPrompt?.(activeRuntimeId, input.text, meta);
            return { status: 'admitted' as const };
        },
        ...(opts.onSendSteerPrompt
            ? {
                async steerInput(
                    activeRuntimeId: string,
                    input: Parameters<ExecutionRunHostRuntime['deliverInput']>[1],
                    meta?: PromptMeta,
                ) {
                    await opts.onSendSteerPrompt!(activeRuntimeId, input.text, meta);
                    return { status: 'admitted' as const };
                },
            }
            : {}),
        async cancel(activeRuntimeId) {
            await opts.onCancel?.(activeRuntimeId);
        },
        subscribeMessages(handler) {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        ...(opts.onRespondToPermission
            ? {
                async respondToPermission(requestId: string, approved: boolean, response?: import('@/agent/permissions/BasePermissionHandler').PermissionResult) {
                    return response === undefined ? await opts.onRespondToPermission!(requestId, approved)
                        : await opts.onRespondToPermission!(requestId, approved, response);
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
            lifetime.abort();
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
