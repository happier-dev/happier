import type {
    AgentRuntimeFactory,
    AgentRuntimeRegistrationOptions,
} from './agentRuntime/index.js';
import type { JsonValue, PluginReference } from './identity.js';
import type { PluginInvocationContext } from './invocation.js';
import type { Disposable } from './lifecycle.js';
import type { PluginUiHostApi } from './ui/hostApi.js';
import type { ScmBackendRuntimeRegistration } from './scm/backend.js';
import type { ScmHostingProviderRuntimeRegistration } from './scm/hostingProvider.js';
import type {
    VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
    PluginConnectedAccountRegistrationApi,
    PluginNotificationDeliveryResult,
} from './services/index.js';
import type { HttpMethod } from './services/io.js';
import type { PluginMcpDiscoveredServer, PluginMcpTool } from './services/resources.js';
import type { AgentExternalSessionsContribution } from './externalSessions.js';
import type { AgentExternalSessionObservationContribution } from './externalSessionObservation.js';
import type {
    AgentExternalSessionHooksContribution,
} from './externalSessionHooks.js';
import type {
    AgentExternalSessionTakeoverContribution,
} from './sessions/externalSessionTakeover.js';
import type {
    PluginVoiceAgentSessionRealtimeService,
} from './experimental/agentRuntime/realtime.js';

export type {
    AgentExternalSessionCandidate,
    AgentExternalSessionLinkData,
    AgentExternalSessionLinkDataValue,
    AgentExternalSessionSource,
    AgentExternalSessionTranscriptItem,
    AgentExternalSessionsContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsListCandidatesRequest,
    AgentExternalSessionsListCandidatesResult,
    AgentExternalSessionsPageTranscriptRequest,
    AgentExternalSessionsReadAfterTranscriptRequest,
    AgentExternalSessionsResult,
    AgentExternalSessionsResolvedIdentity,
    AgentExternalSessionsResolveLinkedIdentityRequest,
    AgentExternalSessionsResolveLinkIdentityRequest,
    AgentExternalSessionsResolveSourceRequest,
    AgentExternalSessionsResolveSourceResult,
    AgentExternalSessionsTranscriptPage,
} from './externalSessions.js';
export type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationDescribeResourceRequest,
    AgentExternalSessionObservationObserveResourceRequest,
    AgentExternalSessionObservationReconcileLink,
    AgentExternalSessionObservationReconcileResourceRequest,
} from './externalSessionObservation.js';
export type ActionHandler<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void> =
    (input: I, context: PluginInvocationContext) => O | Promise<O>;
export type HookHandler<TPayload extends JsonValue = JsonValue, TResult extends JsonValue | void = JsonValue | void> =
    (payload: TPayload, context: PluginInvocationContext) => TResult | Promise<TResult>;
export type PluginEventHandler<TPayload extends JsonValue = JsonValue> =
    (payload: TPayload, context: PluginInvocationContext) => void | Promise<void>;
export type PluginNotificationSendRequest = Readonly<{
    clientRequestId: string;
    deliveryId: string;
    categoryId: string;
    channelId: string;
    title: string;
    body?: string;
    data?: JsonValue;
}>;
export type PluginNotificationSendResult = PluginNotificationDeliveryResult;
export type PluginNotificationSender = (
    request: PluginNotificationSendRequest,
    context: PluginInvocationContext,
) => PluginNotificationSendResult | Promise<PluginNotificationSendResult>;
export interface PluginNotificationRegistrationApi {
    registerChannel(id: string, sender: PluginNotificationSender): void;
}

export type PluginScmHostingProviderRuntime = Omit<ScmHostingProviderRuntimeRegistration, 'id'>;
export type PluginScmBackendRuntime = Omit<ScmBackendRuntimeRegistration, 'id'>;
export interface PluginScmRegistrationApi {
    registerHostingProvider(id: string, runtime: PluginScmHostingProviderRuntime): void;
    registerBackend(id: string, runtime: PluginScmBackendRuntime): void;
}

export type PluginMcpListToolsRequest = Readonly<{ cursor?: string; limit?: number }>;
export type PluginMcpListToolsResult = Readonly<{ items: readonly PluginMcpTool[]; nextCursor?: string }>;
export type PluginMcpToolCallRequest = Readonly<{ name: string; input: JsonValue }>;
export type PluginMcpToolCallContent =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'resource'; resource: PluginReference; contentType?: string }>
    | Readonly<{ kind: 'json'; value: JsonValue }>;
export type PluginMcpToolCallResult = Readonly<{
    content: readonly PluginMcpToolCallContent[];
    isError?: boolean;
}>;
export interface PluginMcpServerRuntime extends Disposable {
    listTools(request: PluginMcpListToolsRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpListToolsResult>;
    callTool(request: PluginMcpToolCallRequest, context: PluginInvocationContext, options?: { signal?: AbortSignal }): Promise<PluginMcpToolCallResult>;
}
export type PluginMcpDiscoveryRequest = Readonly<{
    query?: string;
    cursor?: string;
    limit?: number;
    sessionId?: string;
    accountId?: string | null;
    workspaceId?: string | null;
    directory?: string | null;
}>;
type PluginMcpExecutableLaunch = Readonly<{
    kind: 'agent-cli'; agentId: string; args?: readonly string[]; cwd?: string;
    env?: Readonly<Record<string, string>>; unsetEnvKeys?: readonly string[]; stdin?: string | Uint8Array;
}> | Readonly<{
    kind: 'binary'; executablePath: string; args?: readonly string[]; cwd?: string;
    env?: Readonly<Record<string, string>>; unsetEnvKeys?: readonly string[]; stdin?: string | Uint8Array;
}> | Readonly<{
    kind: 'managed-installable'; installableId: string; executableName?: string; args?: readonly string[];
    cwd?: string; env?: Readonly<Record<string, string>>; unsetEnvKeys?: readonly string[];
    stdin?: string | Uint8Array; sourcePreference?: 'managed-first';
}> | Readonly<{ kind: 'ipc'; endpoint: string }>;
type PluginMcpManagedServerCredential = Readonly<{
    envKey: string; value: string; httpHeader?: Readonly<{ name: string; value: string }>;
}>;
type PluginMcpManagedServerMode = Readonly<{
    kind: 'managed-spawn'; host?: string; port?: number; baseUrl?: string; portArg?: string;
    portEnvKey?: string; baseUrlEnvKey?: string; credential?: PluginMcpManagedServerCredential;
}> | Readonly<{
    kind: 'external-attach'; baseUrl: string; credential?: PluginMcpManagedServerCredential;
}>;
type PluginMcpManagedServerSpec = Readonly<{
    id: string;
    launch?: PluginMcpExecutableLaunch;
    mode?: PluginMcpManagedServerMode;
    healthCheck?: Readonly<{
        kind: 'http'; url?: string; path?: string; headers?: Readonly<Record<string, string>>; timeoutMs?: number;
    }> | Readonly<{ kind: 'command'; launch: PluginMcpExecutableLaunch; timeoutMs?: number }>;
    orphanReaper?: Readonly<{
        executablePath: string; commandIncludes?: readonly string[]; initialSignal?: string;
        forceSignal?: string; forceAfterMs?: number;
    }>;
    watchdog?: Readonly<{ intervalMs: number; missedIntervals: number }>;
    durableLog?: Readonly<{ enabled?: boolean; dir?: string; keepCount?: number }>;
    launchFingerprint?: string;
    startupTimeoutMs?: number;
    restart?: 'never';
    signal?: AbortSignal;
}>;
type PluginMcpHostedToolContent = Readonly<{
    type: 'text'; text: string; annotations?: unknown; _meta?: Record<string, unknown>;
}>;
type PluginMcpHostedToolResult = Readonly<{
    content: readonly PluginMcpHostedToolContent[]; structuredContent?: unknown;
    isError?: boolean; _meta?: Record<string, unknown>;
}>;
type PluginMcpHostedToolDefinition = Readonly<{
    name: string; title?: string | null; description?: string | null; inputSchema?: unknown; outputSchema?: unknown;
    annotations?: Readonly<{
        title?: string; readOnlyHint?: boolean; destructiveHint?: boolean;
        idempotentHint?: boolean; openWorldHint?: boolean;
    }>;
    _meta?: Record<string, unknown>;
    handler(
        args: unknown,
        context: Readonly<{ pluginId: string; serverId: string; toolName: string; signal: AbortSignal }>,
    ): PluginMcpHostedToolResult | Promise<PluginMcpHostedToolResult>;
}>;
type PluginMcpServerSpec = Readonly<{
    id: string; name: string; title?: string | null; description?: string | null;
    transport:
        | Readonly<{
            kind: 'hosted';
            exposure?: Readonly<{ kind: 'registryOnly' }> | Readonly<{ kind: 'loopbackHttp'; requested: true }>;
        }>
        | Readonly<{ kind: 'stdio'; launch: PluginMcpExecutableLaunch }>
        | Readonly<{ kind: 'managed'; server: PluginMcpManagedServerSpec; url?: string }>
        | Readonly<{ kind: 'http' | 'sse'; url: string }>;
    hosted?: Readonly<{ tools?: readonly PluginMcpHostedToolDefinition[] }>;
}>;
type PluginMcpDiscoveryWarning = Readonly<{
    code: 'read_failed' | 'parse_failed' | 'unsupported';
    path?: string;
    detail?: string;
}>;
export type PluginMcpDiscoveryResult = Readonly<{
    items: readonly PluginMcpDiscoveredServer[];
    nextCursor?: string;
    servers?: readonly PluginMcpServerSpec[];
    warnings?: readonly PluginMcpDiscoveryWarning[];
}>;
export interface PluginMcpRegistrationApi {
    registerServer(id: string, runtime: PluginMcpServerRuntime): void;
    registerDiscoveryProvider(
        id: string,
        discover: (
            request: PluginMcpDiscoveryRequest,
            context: PluginInvocationContext,
        ) => PluginMcpDiscoveryResult | Promise<PluginMcpDiscoveryResult>,
    ): void;
}

export type PluginInterceptedRequest = Readonly<{ url: string; method: HttpMethod; headers: Readonly<Record<string, string>>; body?: Uint8Array }>;
export type PluginInterceptorResult =
    | Readonly<{ decision: 'continue'; request: PluginInterceptedRequest }>
    | Readonly<{ decision: 'deny'; code: string }>;
export type PluginRequestInterceptor = (request: PluginInterceptedRequest, context: PluginInvocationContext) =>
    PluginInterceptorResult | Promise<PluginInterceptorResult>;
export interface PluginInterceptorRegistrationApi { register(id: string, interceptor: PluginRequestInterceptor): void }

export type PluginVoiceConnectionCloseReason = Readonly<{
    code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error';
    detail?: string;
}>;
export type PluginVoicePlaybackInterruptionMode = 'retained' | 'ducked' | 'unsupported';
export type PluginVoicePlaybackInterruptionResolution = 'false_alarm' | 'confirmed';
export type PluginVoiceRealtimeTransportEvent =
    | Readonly<{ type: 'session_identity'; sessionId: string }>
    | Readonly<{
        type: 'webrtc_remote_track';
        track: unknown;
        streams: readonly unknown[];
        replacesTrackId?: string;
    }>
    | Readonly<{
        type: 'webrtc_ice_state';
        state: 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
    }>
    | Readonly<{
        type: 'webrtc_data_channel_state';
        state: 'connecting' | 'open' | 'closing' | 'closed';
    }>;

export type PluginVoiceConnectionDriver = Readonly<{
    open(input: Readonly<{
        signal: AbortSignal;
        onControl(event: unknown): void;
        onTransport(event: PluginVoiceRealtimeTransportEvent): void;
        onRemoteClose(reason: string): void;
    }>): Promise<void>;
    sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
    beginOutputInterruptionCandidate?(): PluginVoicePlaybackInterruptionMode;
    resolveOutputInterruptionCandidate?(resolution: PluginVoicePlaybackInterruptionResolution): void;
    close(reason: PluginVoiceConnectionCloseReason): Promise<void>;
}>;

export type PluginVoiceRealtimeConnection = Readonly<{
    readonly kind: 'websocket_pcm' | 'webrtc' | 'sdk_handle';
    connect(signal: AbortSignal): Promise<void>;
    sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
    controlEvents(signal: AbortSignal): AsyncIterable<VoiceRealtimeJsonValue>;
    transportEvents(signal: AbortSignal): AsyncIterable<PluginVoiceRealtimeTransportEvent>;
    close(reason: PluginVoiceConnectionCloseReason): Promise<void>;
    state(): 'idle' | 'connecting' | 'open' | 'closed';
    currentProviderSessionId(): string | null;
    playbackCursorMs(): number | null;
    beginOutputInterruptionCandidate(): PluginVoicePlaybackInterruptionMode;
    resolveOutputInterruptionCandidate(resolution: PluginVoicePlaybackInterruptionResolution): void;
}>;

export type PluginVoicePcmCaptureError =
    | 'web_pcm_capture_backpressure'
    | 'web_pcm_capture_chunk_failed'
    | 'web_pcm_capture_device_lost'
    | 'web_pcm_capture_invalid_chunk'
    | 'web_pcm_capture_media_source_failed'
    | 'web_pcm_capture_mic_acquisition_failed'
    | 'web_pcm_capture_mic_state_unavailable'
    | 'web_pcm_capture_resume_failed'
    | 'web_pcm_capture_unavailable';

export type PluginVoicePcmConnection = Readonly<{
    connection: PluginVoiceRealtimeConnection;
    enqueueOutput(base64Pcm16Le: string): boolean;
    clearOutput(): void;
    waitForOutputDrain(signal: AbortSignal): Promise<void>;
}>;

export type PluginVoiceConnectionMediaHost = Readonly<{
    createSdkHandleConnection(input: Readonly<{
        driver: PluginVoiceConnectionDriver;
    }>): PluginVoiceRealtimeConnection;
    createWebRtcConnection(input: Readonly<{
        signaling: Readonly<{
            exchangeOffer(input: Readonly<{
                offerSdp: string;
                signal: AbortSignal;
            }>): Promise<Readonly<{
                answerSdp: string;
            }>>;
        }>;
        control: Readonly<{
            label: string;
            onOpen(input: Readonly<{
                sendJson(value: VoiceRealtimeJsonValue): Promise<void>;
            }>): void | Promise<void>;
        }>;
    }>): PluginVoiceRealtimeConnection;
    createPcmConnection(input: Readonly<{
        driver: PluginVoiceConnectionDriver;
        input: Readonly<{ sampleRate: number; chunkMs: number }>;
        output: Readonly<{ sampleRate: number; maxBufferedMs: number }>;
        onInputChunk(base64Pcm16Le: string): void;
        onInputError?(code: PluginVoicePcmCaptureError): void;
    }>): PluginVoicePcmConnection;
}>;

export type PluginVoiceMicSession = Readonly<{
    ensureActive(): Promise<void>;
    setMuted(muted: boolean): void;
    isMuted(): boolean;
    teardown(): Promise<void>;
    getStream(): MediaStream | null;
    getAudioContext?(): AudioContext | null;
}>;

export type PluginVoiceRealtimePreflight =
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'declined'; code: string }>
    | Readonly<{ kind: 'aborted' }>;
export type PluginVoiceRealtimePreparation =
    | Readonly<{
        kind: 'prepared';
        session: Readonly<{ config: VoiceRealtimeJsonValue; safeMetadata: VoiceRealtimeJsonValue }>;
    }>
    | Readonly<{ kind: 'declined'; code: string }>
    | Readonly<{ kind: 'aborted' }>;
export type PluginVoiceTurnControlAction =
    | 'cancel_response'
    | 'truncate_playback'
    | 'clear_input'
    | 'stop_session'
    | 'resume_session'
    | 'replay_session'
    | 'send_exact_message';
type PluginVoiceTranscriptEvent = Readonly<{
    type: 'voice.transcript.updated' | 'voice.transcript.delta' | 'voice.transcript.final' | 'voice.transcript.corrected';
    v: 1; epoch: number; sequence: number; revision: number; eventId: string; itemId: string;
    role: 'user' | 'assistant'; text: string; provenance: 'live' | 'replay';
}>;
type PluginVoiceToolCall = Readonly<{
    v: 1; responseId: string; callId: string; toolName: string; order: number;
    arguments: VoiceRealtimeJsonValue;
}>;
type PluginVoiceToolResult = Readonly<{
    v: 1; responseId: string; callId: string; toolName: string; order: number;
    status: 'success' | 'denied' | 'error' | 'cancelled' | 'timeout';
    output?: VoiceRealtimeJsonValue; errorCode?: string;
}>;
export type PluginVoiceRealtimeCanonicalEvent =
    | Readonly<{ type: 'auth_expired' }>
    | Readonly<{ type: 'input_speech_started' }>
    | Readonly<{ type: 'input_speech_stopped' }>
    | Readonly<{ type: 'assistant_output_started'; itemId?: string }>
    | Readonly<{ type: 'assistant_output_stopped' }>
    | Readonly<{ type: 'transcript'; event: PluginVoiceTranscriptEvent }>
    | Readonly<{
        type: 'tool_calls';
        responseId: string;
        calls: readonly PluginVoiceToolCall[];
    }>;

export type PluginVoiceRuntimePlatform = 'web' | 'ios' | 'android';

export type PluginVoiceClientToolDefinition = Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
    /**
     * Attempt-scoped execution boundary. The host owns policy, execution,
     * privacy redaction, and stale-attempt fencing; provider leaves only adapt
     * the already-sanitized result to their native SDK.
     */
    execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue>;
}>;

export type PluginVoiceProviderSettingsOperations = Readonly<{
    listCatalog?(input: Readonly<{
        catalog: 'voices' | 'models';
        providerConfig: VoiceRealtimeJsonValue;
        accountOperations: PluginVoiceAccountOperationService;
        signal: AbortSignal;
    }>): Promise<readonly VoiceRealtimeJsonValue[]>;
    provision?(input: Readonly<{
        request: VoiceRealtimeJsonValue;
        providerConfig: VoiceRealtimeJsonValue;
        disabledActionIds: readonly string[];
        extraSystemAppendBlocks: readonly string[];
        accountOperations: PluginVoiceAccountOperationService;
        signal: AbortSignal;
    }>): Promise<VoiceRealtimeJsonValue>;
}>;

/**
 * Attempt-scoped credentialed request boundary for the declared Voice
 * `clientAuth` operation. The host injects the account SavedSecret at the exact
 * request boundary; provider code receives only the bounded response material.
 */
export type PluginVoiceAccountOperationService = Readonly<{
    request(input: Readonly<{
        operationId: string;
        parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        status: number;
        finalUrl: string;
        headers: Readonly<Record<string, string>>;
        body: Uint8Array;
    }>>;
}>;

/**
 * Attempt-scoped access to the host-owned provider conversation identity.
 * The host owns session binding, durable storage, mutation ordering, and stale
 * attempt fencing; the provider owns only its native identity wire semantics.
 */
export type PluginVoiceProviderConversationService = Readonly<{
    read(): Promise<string | null>;
    write(conversationId: string): Promise<void>;
    forget(): Promise<void>;
}>;

/**
 * Attempt-scoped access to Happier-hosted conversation admission and verified
 * completion. The host binds the returned lease internally; provider code
 * cannot select an arbitrary lease or billing identity.
 *
 * This service is present only for a host-authorized bundled contribution.
 * External/community contributions receive `null`.
 */
export type PluginVoiceHostedConversationService = Readonly<{
    start(input: Readonly<{
        sessionId: string | null;
    }>): Promise<
        | Readonly<{
            allowed: true;
            token: string;
            leaseId: string;
            bindingNonce: string;
            expiresAtMs: number;
        }>
        | Readonly<{
            allowed: false;
            reason: string;
        }>
    >;
    complete(input: Readonly<{
        providerConversationId: string;
    }>): Promise<void>;
    abort(): Promise<void>;
}>;

export type PluginVoiceProviderExecutionAuthority =
    | Readonly<{
        kind: 'direct_media';
      }>
    | Readonly<{
        kind: 'experimental_agent_session_realtime';
        agentSessionRealtime: PluginVoiceAgentSessionRealtimeService;
      }>;

export type PluginVoiceProviderProtocol = Readonly<{
    preflight?(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        request: VoiceRealtimeJsonValue;
        platform: PluginVoiceRuntimePlatform;
        providerConfig: VoiceRealtimeJsonValue;
        signal: AbortSignal;
    }>): Promise<PluginVoiceRealtimePreflight>;
    prepare(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        reason: 'initial' | 'reconnect' | 'auth_refresh';
        request: VoiceRealtimeJsonValue;
        platform: PluginVoiceRuntimePlatform;
        providerConfig: VoiceRealtimeJsonValue;
        accountOperations: PluginVoiceAccountOperationService;
        providerConversation: PluginVoiceProviderConversationService | null;
        hostedConversation: PluginVoiceHostedConversationService | null;
        signal: AbortSignal;
    }>): Promise<PluginVoiceRealtimePreparation>;
    decodeControl(event: VoiceRealtimeJsonValue): readonly PluginVoiceRealtimeCanonicalEvent[];
    encodeTurnControl(
        action: PluginVoiceTurnControlAction,
        payload?: VoiceRealtimeJsonValue,
    ): VoiceRealtimeJsonValue | null;
    refreshAuth?(signal: AbortSignal): Promise<boolean>;
    releasePrepared?(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        reason: PluginVoiceConnectionCloseReason;
    }>): Promise<void> | void;
}>;

export type PluginVoiceProviderRuntimeRegistration = Readonly<{
    protocol: PluginVoiceProviderProtocol;
    /** Provider-owned settings operations over host-bounded account access. */
    settingsOperations?: PluginVoiceProviderSettingsOperations;
    createConnection(input: Readonly<{
        session: Readonly<{
            config: VoiceRealtimeJsonValue;
            safeMetadata: VoiceRealtimeJsonValue;
        }>;
        attemptId: number;
        mic: PluginVoiceMicSession;
        interruption: Readonly<{ duckGain: number; retainedOutputMaxMs: number }>;
        levels: Readonly<{ onOutputLevel(level: number): void }>;
        /**
         * Attempt-scoped access to the host's canonical WebRTC wrapper and raw
         * PCM capture/playback owner. Provider wire/protocol logic stays in the
         * leaf; this host owns media buffering, interruption, levels, and cleanup.
         */
        media: PluginVoiceConnectionMediaHost;
        /** Canonical enabled Voice tools for this attempt; execution remains host-owned. */
        tools: readonly PluginVoiceClientToolDefinition[];
        /** Operation-bound generic UI host. Activation remains registration-only. */
        ui: PluginUiHostApi;
        /** Caller lifetime; the host also binds it to every operation on `ui`. */
        signal: AbortSignal;
        /** Exact attempt-scoped execution authority selected by the host. */
        execution: PluginVoiceProviderExecutionAuthority;
    }>): Promise<PluginVoiceRealtimeConnection>;
    encodeToolResults(results: readonly PluginVoiceToolResult[]): readonly VoiceRealtimeJsonValue[];
    encodeToolContinuation(responseId: string): VoiceRealtimeJsonValue;
    beforeToolContinuation?(responseId: string, signal: AbortSignal): Promise<void>;
    beforeInterrupt?(): Promise<void> | void;
    forgetProviderConversation?(): Promise<void>;
    dispose?(): Promise<void> | void;
    encodePostCancelControls?(): readonly VoiceRealtimeJsonValue[];
    encodePostBargeInControls?(): readonly VoiceRealtimeJsonValue[];
    requiresMicForConnection?: boolean;
    setInputMuted?(muted: boolean): Promise<void> | void;
    encodeContextUpdate(text: string): readonly VoiceRealtimeJsonValue[];
    encodeTextTurn(text: string): readonly VoiceRealtimeJsonValue[];
    outputLevelMeter?: 'measured' | 'unavailable';
}>;

export type PluginVoiceSpeechCatalogItem = Readonly<{
    id: string;
    name: string;
    metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type PluginVoiceSpeechSchema<T = unknown> = Readonly<{
    safeParse(value: unknown): { success: true; data: T } | { success: false };
    parse(value: unknown): T;
}>;

/**
 * Operation-scoped access to a host-owned credential. The host retains storage,
 * selection, and lifetime ownership; a trusted bundled leaf can use the secret
 * only inside the supplied callback.
 */
export type PluginVoiceSpeechCredentialAccess = <T>(
    use: (secret: string) => Promise<T>,
) => Promise<T>;

export type PluginVoiceSpeechTranscribeRequest = Readonly<{
    requestId: string;
    model: string;
    language: string | null;
    mimeType: string;
    uploadId: string;
}>;

export type PluginVoiceSpeechSynthesizeRequest = Readonly<{
    requestId: string;
    input: string;
    voiceName: string;
    languageCode: string | null;
    format: 'mp3' | 'wav';
    speakingRate: number | null;
    pitch: number | null;
    recipientPublicKeyBase64: string;
}>;

export type PluginVoiceSpeechRuntimeRegistration = Readonly<{
    catalogProviders: readonly Readonly<{
        providerId: string;
        catalogOperations: Readonly<{
            fetchCatalog(params: Readonly<{
                credential: PluginVoiceSpeechCredentialAccess;
                catalog: 'voices' | 'models';
                signal: AbortSignal;
            }>): Promise<readonly PluginVoiceSpeechCatalogItem[]>;
        }>;
    }>[];
    operations: Readonly<{
        transcribe(params: Readonly<{
            credential: PluginVoiceSpeechCredentialAccess;
            request: Omit<PluginVoiceSpeechTranscribeRequest, 'uploadId'> & Readonly<{ bytes: Uint8Array }>;
            signal: AbortSignal;
        }>): Promise<Readonly<{ requestId: string; text: string }>>;
        synthesize(params: Readonly<{
            credential: PluginVoiceSpeechCredentialAccess;
            request: PluginVoiceSpeechSynthesizeRequest;
            signal: AbortSignal;
        }>): Promise<Readonly<{
            requestId: string;
            bytes: Uint8Array;
            mimeType: 'audio/mpeg' | 'audio/wav';
        }>>;
    }>;
    speechProviderIds: Readonly<{
        transcribe: string;
        synthesize: string;
    }>;
    schemas: Readonly<{
        transcribeRequest: PluginVoiceSpeechSchema<PluginVoiceSpeechTranscribeRequest>;
        transcribeResponse: PluginVoiceSpeechSchema;
        synthesizeRequest: PluginVoiceSpeechSchema<PluginVoiceSpeechSynthesizeRequest>;
        synthesizeResponse: PluginVoiceSpeechSchema;
    }>;
}>;

export interface PluginVoiceProviderRegistrationApi {
    register(id: string, runtime: PluginVoiceProviderRuntimeRegistration): void;
    registerSpeech(id: string, runtime: PluginVoiceSpeechRuntimeRegistration): void;
}

export type PluginCleanup = () => void | Promise<void>;

export interface PluginApi {
    readonly actions: { register<I extends JsonValue = JsonValue, O extends JsonValue | void = JsonValue | void>(id: string, handler: ActionHandler<I, O>): void };
    readonly hooks: { register(id: string, handler: HookHandler): void };
    readonly events: { register<TPayload extends JsonValue = JsonValue>(subscriptionId: string, handler: PluginEventHandler<TPayload>): void };
    readonly agents: {
        register(
            id: string,
            factory: AgentRuntimeFactory,
            options?: AgentRuntimeRegistrationOptions,
        ): void;
        registerExternalSessions(id: string, contribution: AgentExternalSessionsContribution): void;
        registerExternalSessionHooks(
            id: string,
            contribution: AgentExternalSessionHooksContribution,
        ): void;
        registerExternalSessionObservation(
            id: string,
            contribution: AgentExternalSessionObservationContribution,
        ): void;
        registerExternalSessionTakeover(
            id: string,
            contribution: AgentExternalSessionTakeoverContribution,
        ): void;
    };
    readonly notifications: PluginNotificationRegistrationApi;
    readonly connectedAccounts: PluginConnectedAccountRegistrationApi;
    readonly scm: PluginScmRegistrationApi;
    readonly mcp: PluginMcpRegistrationApi;
    readonly interceptors: PluginInterceptorRegistrationApi;
    readonly voiceProviders: PluginVoiceProviderRegistrationApi;
}

export type PluginActivationModule = Readonly<{
    activate(api: PluginApi): void | PluginCleanup | Promise<void | PluginCleanup>;
}>;
