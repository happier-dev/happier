import type { AgentMessage } from '@/agent/core/AgentMessage';

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

export type ExecutionRunPermissionCapability = 'responds' | 'inline' | 'static';

export type RuntimePermissionResponseOutcome = Readonly<{ delivered: true }>
    | Readonly<{
        delivered: false;
        reason: 'no_active_session' | 'unknown_request';
    }>;

export type ExecutionRunHostRuntime = Readonly<{
    permissionCapability?: ExecutionRunPermissionCapability;
    readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
    provisionSession: (opts?: ExecutionRunSessionProvisionOptions) => Promise<ExecutionRunSessionProvisionResult>;
    sendPrompt: (
        sessionId: string,
        prompt: string,
        meta?: Readonly<{
            localInputId?: string | null;
            localInputIds?: readonly string[];
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>,
    ) => Promise<void>;
    sendSteerPrompt?: (
        sessionId: string,
        prompt: string,
        meta?: Readonly<{
            localInputId?: string | null;
            localInputIds?: readonly string[];
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>,
    ) => Promise<void>;
    cancel: (sessionId: string) => Promise<void>;
    subscribeMessages: (handler: ExecutionRunHostRuntimeMessageHandler) => () => void;
    respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
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
