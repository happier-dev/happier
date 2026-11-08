import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
    ExecutionRunInteractionV1,
    ExecutionRunResultContractV1,
    SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import type { AgentSessionInput, AgentSessionSendResult, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';

/** The incumbent host admission context; routing never crosses the Agent SDK input boundary. */
export type ExecutionRunInputContext = Omit<RuntimeTurnPromptMeta, 'structuredInput'>;

export type ExecutionRunNativeInputContext = ExecutionRunInputContext & Readonly<{
    resultContract?: ExecutionRunResultContractV1;
    /** Current input's private caller mode; never part of an Agent SDK send. */
    effectiveCallerPermissionMode?: string;
}>;

export type ExecutionRunHostRuntimeMessageHandler = (message: AgentMessage) => void;

/** Host-only recovery progress and detached termination extend the SDK events. */
export type ExecutionRunHostRuntimeEvent = AgentSessionRuntimeEvent
    | Readonly<{ kind: 'recovery-waiting'; turnId: string; recovery: SessionUsageLimitRecoveryV1 }>
    | Omit<Extract<AgentSessionRuntimeEvent, { kind: 'runtime-ended' }>, 'sessionId' | 'sequence'>;

export type ExecutionRunRuntimeProvisionOptions = Readonly<{
    initialPrompt?: string;
    resumeRuntimeId?: string;
    captureReplay?: boolean;
}>;

export type ExecutionRunRuntimeProvisionResult = Readonly<{
    runtimeId: string;
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
    /** Host projection from the current permission store, never plugin-authored state. */
    readPendingPermissionRequests?: () => readonly Readonly<{ requestId: string; createdAt?: number }>[];
    permissionCapability?: ExecutionRunPermissionCapability;
    /**
     * Present only when this exact runtime is the retained Agent Session adapter.
     * It is the actual adapter choice plus the selected generation's declared
     * Session capabilities — never inferred from status, intent, or run class.
     */
    interaction?: ExecutionRunInteractionV1;
    readResumeSupport: (opts?: Readonly<{ captureReplay?: boolean }>) => Promise<boolean>;
    /** Prepare this Run's exact host input prefix before profile sizing, without sending input. */
    prepareInputBudget?: () => Promise<number | undefined>;
    /** Published window of this runtime's prepared Provider/Team model; no default. */
    readModelContextWindowTokens?: () => number | undefined;
    /** Authoritative provider thread identity; never the host dispatch runtime id. */
    readProviderSessionId?: () => string | null;
    /** Retained Session owner joins cancellation before proving another turn is admissible. */
    canContinueAfterCancellation?: (timeoutMs?: number | null) => Promise<boolean>;
    provisionRuntime: (opts?: ExecutionRunRuntimeProvisionOptions) => Promise<ExecutionRunRuntimeProvisionResult>;
    deliverInput: (
        runtimeId: string,
        input: AgentSessionInput,
        context?: ExecutionRunNativeInputContext,
    ) => Promise<AgentSessionSendResult>;
    steerInput?: (
        runtimeId: string,
        input: AgentSessionInput,
        context?: ExecutionRunNativeInputContext,
    ) => Promise<AgentSessionSendResult>;
    getRuntimeLifetimeSignal: () => AbortSignal;
    /** Exact native custody evidence, independent of the send command's admission acknowledgement. */
    subscribeProviderInputOutcomes?: (handler: (outcome: SessionProviderInputOutcome) => void) => () => void;
    /** Validated native turn evidence; generic Run status is not exact completion proof. */
    subscribeRuntimeEvents?: (handler: (event: ExecutionRunHostRuntimeEvent) => void) => () => void;
    readActiveTurnAdmissionWitness?: () => AgentInvocationTurnAdmissionWitness | null;
    cancel: (runtimeId: string) => Promise<void>;
    subscribeMessages: (handler: ExecutionRunHostRuntimeMessageHandler) => () => void;
    respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
    /** Rejects and durably settles only permission waits owned by this Run occurrence. */
    abortPendingPermissionRequests?: (reason: string) => Promise<void>;
    waitForTurnCompletion?: (timeoutMs?: number | null) => Promise<void>;
    probeTurnLiveness?: (runtimeId: string) => Promise<ExecutionRunTurnLivenessProbeResult>;
    dispose: () => Promise<void>;
}>;

export function isExecutionRunHostRuntime(runtime: unknown): runtime is ExecutionRunHostRuntime {
    return typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.readResumeSupport === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.provisionRuntime === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.deliverInput === 'function'
        && typeof (runtime as ExecutionRunHostRuntime | null | undefined)?.getRuntimeLifetimeSignal === 'function'
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
