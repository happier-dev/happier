import type { AgentMessage } from '@/agent/core';

export type ExecutionRunHostRuntimeMessageHandler = (message: AgentMessage) => void;

export type ExecutionRunSessionProvisionOptions = Readonly<{
    initialPrompt?: string;
    resumeSessionId?: string;
    captureReplay?: boolean;
}>;

export type ExecutionRunSessionProvisionResult = Readonly<{
    sessionId: string;
}>;

export type ExecutionRunTurnLivenessProbeResult = Readonly<{
    active: boolean;
    reason?: string;
    lastActivityAtMs?: number | null;
    diagnostics?: Readonly<Record<string, unknown>>;
}>;

export type ExecutionRunHostRuntime = Readonly<{
    readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
    provisionSession: (opts?: ExecutionRunSessionProvisionOptions) => Promise<ExecutionRunSessionProvisionResult>;
    sendPrompt: (sessionId: string, prompt: string) => Promise<void>;
    sendSteerPrompt?: (sessionId: string, prompt: string) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    subscribeMessages: (handler: ExecutionRunHostRuntimeMessageHandler) => () => void;
    respondToPermission?: (requestId: string, approved: boolean) => Promise<void>;
    waitForTurnCompletion?: (timeoutMs?: number | null) => Promise<void>;
    probeTurnLiveness?: (sessionId: string) => Promise<ExecutionRunTurnLivenessProbeResult>;
    dispose: () => Promise<void>;
}>;

export function isExecutionRunHostRuntime(runtime: unknown): runtime is ExecutionRunHostRuntime {
    return typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.readResumeSupport === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.provisionSession === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.sendPrompt === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.cancel === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.subscribeMessages === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.dispose === 'function';
}

export function requireExecutionRunHostRuntime(
    runtime: unknown,
    errorMessage = 'Execution-run runtime must implement ExecutionRunHostRuntime',
): ExecutionRunHostRuntime {
    if (isExecutionRunHostRuntime(runtime)) {
        return runtime;
    }
    throw new Error(errorMessage);
}
