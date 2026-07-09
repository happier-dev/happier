import type {
    ProviderMessageMetaEnricher,
    RuntimeConfigUpdateOutcomeV1,
    RuntimeCore,
} from '@happier-dev/agents';
import type {
    BackendTargetRefV2Input,
    SessionConnectedServiceAuthApplyGenerationRequestV1,
    SessionConnectedServiceAuthApplyGenerationResponseV1,
    SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
    SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
} from '@happier-dev/protocol';
import type { RuntimeEventV1, RuntimeInputPayloadV1 as ProtocolRuntimeInputPayloadV1 } from '@happier-dev/protocol/runtime';

import type { SessionScopedServicesV1 } from '../sessions/scoped.js';

export {
    isRuntimeConfigUpdateOutcomeApplied,
    readSessionMetadataRuntimeDescriptor,
    resolveRecoverableTurnFailureRetryDecision,
    resolveRecoverableTurnFailureSecondFailure,
    resolveMetadataStringOverrideV1,
    type RuntimeConfigUpdateOutcomeV1,
    type RecoverableTurnFailurePromptMode,
    type RecoverableTurnFailureRetryDecision,
    type RecoverableTurnFailureSecondFailureDecision,
} from '@happier-dev/agents';
export type {
    HostRuntimeControlAppServerDelegateInputV1,
    HostRuntimeControlAppServerDelegateV1,
    HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
    HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1,
    HostRuntimeControlContextV1,
    HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
    HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1,
    HostRuntimeControlResultV1,
    HostRuntimeControlServiceV1,
    RuntimeOutboundTranscriptDispatchFacetV1,
    RuntimeOutboundTranscriptDispatchInputV1,
    RuntimeOutboundTranscriptDispatchPlanV1,
    RuntimeOutboundTranscriptPostSendEffectV1,
    RuntimeOutboundTranscriptToolNormalizationV1,
    RuntimeOutboundTranscriptToolTraceEventV1,
    TerminalControlCaptureResult,
    TerminalControlPort,
    TerminalControlSendResult,
    TerminalHostHandle,
    TerminalHostKind,
    TerminalHostPreference,
    TerminalInputInjectionResult,
    TerminalInputReadinessV1,
    TerminalPromptInput,
    TerminalSpecialKey,
} from '@happier-dev/agents';
export {
    isNonSteerablePromptPayload,
    parseSpecialCommand,
    SESSION_PROVIDER_HOOK_EVENT_ID_V1,
    SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    readRuntimeDescriptorV1FromMetadata,
    resolveTranscriptBodySessionMessageRole,
} from '@happier-dev/protocol';
export type {
    ResolveTranscriptBodySessionMessageRoleInput,
    RuntimeConfigOutcomeChangeKeyV1,
    RuntimeConfigOutcomeStatusV1,
    RuntimeConfigOutcomeTimingV1,
    SessionConnectedServiceAuthApplyGenerationAppliedViaV1,
    SessionConnectedServiceAuthApplyGenerationReasonV1,
    SessionConnectedServiceAuthApplyGenerationRequestV1,
    SessionConnectedServiceAuthApplyGenerationResponseV1,
    SessionConnectedServiceAuthReadRuntimeIdentityReasonV1,
    SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
    SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
    SessionConnectedServiceAuthRuntimeIdentityProofStrengthV1,
    SessionConnectedServiceAuthRuntimeIdentityStrategyV1,
    SessionTerminalComposerClearResultV1,
    SessionMessageRole,
    SessionRollbackTarget,
    SessionTurnV1,
    SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
export {
    readHappierStructuredInputV1FromMeta,
    RuntimeEventV1Schema,
    type HappierStructuredInputV1,
    type RuntimeEventKindV1,
    type RuntimeEventV1,
    type RuntimeInputPayloadV1,
} from '@happier-dev/protocol/runtime';
export type {
    SessionRuntimeIssueV1,
    SessionRuntimeIssueSourceV1,
    SessionRuntimeTemporaryThrottleDetailsV1,
    SessionRuntimeUsageLimitDetailsV1,
} from '@happier-dev/protocol';
export {
    buildSessionRuntimeIssueV1,
    type BuildSessionRuntimeIssueV1Input,
} from './issues.js';
export {
    resolveTerminalPromptProviderAcceptanceTimeoutMs,
    resolveTerminalPromptWriteBudget,
    resolveTerminalPromptWriteTimeoutMs,
    type TerminalPromptWriteBudget,
} from './promptWriteTimeout.js';

export type RuntimeDeliveryModeV1 = 'steer' | 'followUp';

export type RuntimeSendOptionsV1 = Readonly<{
    signal?: AbortSignal;
    localInputId?: string;
    localInputIds?: readonly string[];
    providerClaimedPendingLocalIds?: readonly string[];
    turnId?: string;
    deliverAs?: RuntimeDeliveryModeV1;
    modelId?: string;
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
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

export type SessionRuntimeIdentitySnapshotV1 = Readonly<{
    providerSessionId: string | null;
}>;

export type SessionRuntimeIdentityV1 = Readonly<{
    read(): SessionRuntimeIdentitySnapshotV1;
}>;

export type SessionRuntimeEventsV1 = Readonly<{
    subscribe(handler: (event: RuntimeEventV1) => void): () => void;
}>;

export type RuntimePermissionResponseOutcomeV1 =
    | Readonly<{ delivered: true }>
    | Readonly<{
        delivered: false;
        reason: 'no_active_session' | 'unknown_request';
    }>;

export type RuntimePermissionResponseDecisionV1 = Readonly<{
    requestId: string;
    approved: boolean;
}>;

export type SessionRuntimePermissionsV1 =
    | Readonly<{
        capability: 'responds';
        respond(decision: RuntimePermissionResponseDecisionV1): Promise<RuntimePermissionResponseOutcomeV1>;
    }>
    | Readonly<{
        capability: 'inline';
    }>
    | Readonly<{
        capability: 'static';
    }>;

export type SessionRuntimeConfigUpdateV1 = Readonly<{
    modeId?: string;
    modelId?: string;
    permissionMode?: string;
    configOption?: Readonly<Record<string, unknown>>;
}>;

export type RuntimePromptAcceptedInfoV1 = Readonly<{
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type RuntimePromptAcceptedCallbackV1 = (info: RuntimePromptAcceptedInfoV1) => void;

export type RuntimePromptTerminallyRejectedBeforeProviderInfoV1 = Readonly<{
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type RuntimePromptTerminallyRejectedBeforeProviderCallbackV1 = (
    info: RuntimePromptTerminallyRejectedBeforeProviderInfoV1,
) => void;

export type RuntimeUndeliverablePromptV1 = Readonly<{
    text: string;
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type RuntimeUndeliverablePromptsCallbackV1 = (
    prompts: ReadonlyArray<RuntimeUndeliverablePromptV1>,
) => void;

export type SessionRuntimeV1 = Readonly<{
    identity: SessionRuntimeIdentityV1;
    events: SessionRuntimeEventsV1;
    send(input: ProtocolRuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1>;
    cancel?(request: RuntimeCancelRequestV1): Promise<RuntimeCancelResultV1>;
    permissions?: SessionRuntimePermissionsV1;
    updateConfig?(update: SessionRuntimeConfigUpdateV1): Promise<RuntimeConfigUpdateOutcomeV1 | void>;
    setOnPromptAcceptedByProvider?(handler: RuntimePromptAcceptedCallbackV1 | null): void;
    setOnPromptTerminallyRejectedBeforeProvider?(
        handler: RuntimePromptTerminallyRejectedBeforeProviderCallbackV1 | null,
    ): void;
    setOnUndeliverablePrompts?(handler: RuntimeUndeliverablePromptsCallbackV1 | null): void;
    applyConnectedServiceAuthGeneration?(
        request: SessionConnectedServiceAuthApplyGenerationRequestV1,
    ): Promise<SessionConnectedServiceAuthApplyGenerationResponseV1>;
    readConnectedServiceRuntimeIdentity?(
        request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
    ): Promise<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>;
    dispose(reason?: RuntimeDisposeReasonV1): Promise<void>;
}>;

/**
 * Public SDK ABI: third-party plugins author SessionRuntimeV1. Bundled first-party
 * compatibility bridges are intentionally kept off the public root surface.
 */
export type SessionRuntimeCreateResultV1 = SessionRuntimeV1;

export type SessionRuntimeMcpServerConfigV1 = unknown;

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
    mcpServers?: Readonly<Record<string, SessionRuntimeMcpServerConfigV1>> | null;
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

export type ExecutionRunModelOutputMessageV1 =
    | Readonly<{
        type: 'model-output';
        textDelta: string;
    }>
    | Readonly<{
        type: 'model-output';
        fullText: string;
    }>;

export type ExecutionRunHostMessageV1 = RuntimeEventV1 | ExecutionRunStatusMessageV1 | ExecutionRunModelOutputMessageV1;

export type ExecutionRunHostBackendV1 = Readonly<{
    permissionCapability?: SessionRuntimePermissionsV1['capability'];
    readResumeSupport(opts?: Readonly<{ captureReplay?: boolean }>): Promise<boolean>;
    provisionSession(opts?: Readonly<{
        initialPrompt?: string;
        resumeSessionId?: string;
        captureReplay?: boolean;
    }>): Promise<Readonly<{ sessionId: string }>>;
    sendPrompt(
        sessionId: string,
        prompt: string,
        meta?: Readonly<{
            localInputId?: string | null;
            localInputIds?: readonly string[];
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>,
    ): Promise<void>;
    sendSteerPrompt?(
        sessionId: string,
        prompt: string,
        meta?: Readonly<{
            localInputId?: string | null;
            localInputIds?: readonly string[];
            providerClaimedPendingLocalIds?: readonly string[];
            userMessageSeq?: number | null;
            userMessageSeqs?: readonly number[];
        }>,
    ): Promise<void>;
    /**
     * Idempotent cleanup: if no session/start exists yet, resolves without starting a runtime.
     */
    cancel(sessionId: string): Promise<void>;
    subscribeMessages(handler: (message: ExecutionRunHostMessageV1) => void): () => void;
    respondToPermission?(requestId: string, approved: boolean): Promise<RuntimePermissionResponseOutcomeV1>;
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
