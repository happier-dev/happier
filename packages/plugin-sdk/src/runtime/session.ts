import type { ProviderMessageMetaEnricher, RuntimeCore } from '@happier-dev/agents';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type { RuntimeEventV1, RuntimeInputPayloadV1 as ProtocolRuntimeInputPayloadV1 } from '@happier-dev/protocol/runtime';

import type { SessionScopedServicesV1 } from '../sessions/scoped.js';

export type { RuntimeInputPayloadV1 } from '@happier-dev/protocol/runtime';

export type RuntimeSendOptionsV1 = Readonly<{
    signal?: AbortSignal;
    localInputId?: string;
    turnId?: string;
    isSteer?: boolean;
}>;

export type RuntimeSendResultV1 = Readonly<{
    status: 'accepted' | 'unsupported' | 'unavailable' | 'rejected';
    turnId?: string;
    providerTurnId?: string;
    diagnostic?: string;
}>;

export type RuntimeCancelRequestV1 = Readonly<{
    turnId?: string;
    reason?: 'user' | 'host_shutdown' | 'session_dispose' | 'runtime_recovery';
}>;

export type RuntimeCancelResultV1 = Readonly<{
    status: 'cancelled' | 'not_running' | 'unsupported' | 'unavailable';
    diagnostic?: string;
}>;

export type RuntimeDisposeReasonV1 =
    | 'session_closed'
    | 'plugin_deactivated'
    | 'host_shutdown'
    | 'runtime_recovery';

export type SessionRuntimeV1 = Readonly<{
    send(input: ProtocolRuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1>;
    cancel?(request: RuntimeCancelRequestV1): Promise<RuntimeCancelResultV1>;
    dispose(reason?: RuntimeDisposeReasonV1): Promise<void>;
}>;

/**
 * Public SDK ABI: third-party plugins author SessionRuntimeV1. Bundled first-party
 * compatibility bridges are intentionally kept off the public root surface.
 */
export type SessionRuntimeCreateResultV1 = SessionRuntimeV1;

export type CreateSessionRuntimeParamsV1 = Readonly<{
    sessionId?: string;
    backendId?: string;
    cwd?: string;
    directory?: string;
    permissionMode?: string;
    initialRuntimeState?: Readonly<Record<string, unknown>> | null;
    metadata?: Readonly<Record<string, unknown>> | null;
    isolation?: Readonly<{
        env?: Readonly<Record<string, string>>;
    }> | null;
    env?: Readonly<Record<string, string>>;
    providerMessageMetaEnricher?: ProviderMessageMetaEnricher;
    services?: SessionScopedServicesV1;
    signal?: AbortSignal;
}>;

export type ExecutionRunInputV1 = Readonly<{
    prompt?: string;
    sessionId?: string;
    runId?: string;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type ExecutionRunResultV1 = Readonly<{
    status: 'completed' | 'accepted' | 'cancelled' | 'failed' | 'unsupported';
    sessionId?: string;
    diagnostic?: string;
}>;

export type CreateExecutionRunBackendParamsV1 = Readonly<{
    backendId?: string;
    backendTarget?: BackendTargetRefV2Input;
    cwd?: string;
    directory?: string;
    modelId?: string;
    permissionMode?: string;
    runId?: string;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    start?: Readonly<{
        intentInput?: unknown;
        retentionPolicy?: string;
        intent?: string;
    }> | null;
    services?: SessionScopedServicesV1;
    signal?: AbortSignal;
    isolation?: Readonly<{
        env?: Readonly<Record<string, string>>;
    }> | null;
    env?: Readonly<Record<string, string>>;
}>;

export type ExecutionRunBackendV1 = Readonly<{
    run(input: ExecutionRunInputV1, options?: Readonly<{ signal?: AbortSignal }>): Promise<ExecutionRunResultV1>;
    dispose?(reason?: RuntimeDisposeReasonV1): Promise<void>;
}>;

export type ExecutionRunStatusMessageV1 = Readonly<{
    type: 'status';
    status: 'running' | 'idle';
}>;

export type ExecutionRunHostMessageV1 = RuntimeEventV1 | ExecutionRunStatusMessageV1;

export type ExecutionRunHostBackendV1 = Readonly<{
    readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean>;
    provisionSession(opts?: Readonly<{
        initialPrompt?: string;
        resumeSessionId?: string;
        captureReplay?: boolean;
    }>): Promise<Readonly<{ sessionId: string }>>;
    sendPrompt(sessionId: string, prompt: string): Promise<void>;
    sendSteerPrompt?(sessionId: string, prompt: string): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    subscribeMessages(handler: (message: ExecutionRunHostMessageV1) => void): () => void;
    respondToPermission?(requestId: string, approved: boolean): Promise<void>;
    waitForTurnCompletion?(timeoutMs?: number | null): Promise<void>;
    probeTurnLiveness?(sessionId: string): Promise<Readonly<{
        active: boolean;
        reason?: string;
        lastActivityAtMs?: number | null;
        diagnostics?: Readonly<Record<string, unknown>>;
    }>>;
    dispose(): Promise<void>;
}>;

export type ExecutionRunBackendCreateResultV1 =
    | ExecutionRunBackendV1
    | ExecutionRunHostBackendV1;

export type RuntimeCoreV1 = RuntimeCore<
    CreateSessionRuntimeParamsV1,
    SessionRuntimeCreateResultV1,
    CreateExecutionRunBackendParamsV1,
    ExecutionRunBackendCreateResultV1
>;
