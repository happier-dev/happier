/** @moduleRealm client */
import type {
    AgentSessionRealtimeAvailability,
    AgentSessionRealtimeStartInput,
    AgentSessionRealtimeStartResult,
} from '../experimental/agentRuntime/realtimeContracts.js';
import type { ActionSpec } from '../actions/actionTypeMap.generated.js';
import type { PluginUiHostApi } from '../ui/hostApi.js';
import { describeActionForVoiceTool as canonicalDescribeActionForVoiceTool } from '@happier-dev/protocol/actions/actionVoiceToolSummary';
import { isVoiceSdkSafeActionSpec as canonicalIsVoiceSdkSafeActionSpec, listVoiceSdkSafeToolActionSpecs as canonicalListVoiceSdkSafeToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import {
    buildVoiceClientToolAgentPrompt as canonicalBuildVoiceClientToolAgentPrompt,
} from '@happier-dev/agents/voice';
import { describeActionInputFieldForVoice as canonicalDescribeActionInputFieldForVoice } from '@happier-dev/protocol/actions/actionInputVoiceGuidance';
import type {
    VoiceGuidanceAvailability,
} from '@happier-dev/protocol/actions/actionInputVoiceGuidance';
export type { VoiceGuidanceAvailability } from '@happier-dev/protocol/actions/actionInputVoiceGuidance';
export type {
    VoiceConversationCapabilities,
    VoiceConversationProviderRole,
} from '@happier-dev/protocol/plugins/contributions/voice';
import type {
    VoiceRealtimeJsonValue,
    VoiceRealtimeToolCallV1 as VoiceRealtimeToolCall,
    VoiceRealtimeToolResultV1 as VoiceRealtimeToolResult,
    VoiceTranscriptCanonicalEventV1 as VoiceTranscriptCanonicalEvent,
    VoiceTranscriptLadderMapper,
} from '@happier-dev/protocol/voice/realtime';
import { createVoiceTranscriptLadderMapper as canonicalCreateVoiceTranscriptLadderMapper } from '@happier-dev/protocol/voice/realtime/transcriptLadder';
import { projectVoiceRealtimeToolResultOutput as canonicalProjectVoiceRealtimeToolResultOutput, VoiceRealtimeJsonValueSchema as canonicalVoiceRealtimeJsonValueSchema, VoiceRealtimeToolCallV1Schema as canonicalVoiceRealtimeToolCallV1Schema, VoiceRealtimeToolResultV1Schema as canonicalVoiceRealtimeToolResultV1Schema, VoiceTranscriptCanonicalEventV1Schema as canonicalVoiceTranscriptCanonicalEventV1Schema } from '@happier-dev/protocol/voice/realtime/events';
import { HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE as canonicalHappierVoiceBindingNonceDynamicVariable, HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE as canonicalHappierVoiceLeaseIdDynamicVariable } from '@happier-dev/protocol/voice/sessionBinding';
import type { VoiceCredentialAccess, VoiceSchema } from './contracts.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import { normalizeVoiceFailureCode as canonicalNormalizeVoiceFailureCode } from '@happier-dev/protocol/voice/providerOperations';
import {
    describeVoiceToolJsonArguments as canonicalDescribeVoiceToolJsonArguments,
    decodeVoiceToolJsonArguments as canonicalDecodeVoiceToolJsonArguments,
} from '@happier-dev/protocol/voice/realtime/toolArguments';

export const describeVoiceToolJsonArguments: (schema: Readonly<Record<string, unknown>>) => string =
    /* @__PURE__ */ projectProtocolValue(canonicalDescribeVoiceToolJsonArguments);
export const decodeVoiceToolJsonArguments: (parameters: unknown) => unknown =
    /* @__PURE__ */ projectProtocolValue(canonicalDecodeVoiceToolJsonArguments);

export const normalizeVoiceFailureCode: (value: unknown) => string | null =
    /* @__PURE__ */ projectProtocolValue(canonicalNormalizeVoiceFailureCode);

export const describeActionForVoiceTool: (
    spec: Pick<ActionSpec, 'title' | 'description' | 'inputHints'>,
) => string = /* @__PURE__ */ projectProtocolValue(canonicalDescribeActionForVoiceTool);
export const describeActionInputFieldForVoice: (
    spec: Pick<ActionSpec, 'id'>,
    field: NonNullable<ActionSpec['inputHints']>['fields'][number],
    availability?: VoiceGuidanceAvailability,
) => string =
    /* @__PURE__ */ projectProtocolValue(canonicalDescribeActionInputFieldForVoice);
export const isVoiceSdkSafeActionSpec: (spec: Pick<ActionSpec, 'sideEffectClass'>) => boolean =
    /* @__PURE__ */ projectProtocolValue(canonicalIsVoiceSdkSafeActionSpec);
export const listVoiceSdkSafeToolActionSpecs: () => readonly ActionSpec[] =
    /* @__PURE__ */ projectProtocolValue(canonicalListVoiceSdkSafeToolActionSpecs);

export type VoiceClientToolAgentPromptOptions = Readonly<{
    assistantName?: string;
    verbosity?: 'short' | 'balanced';
    /**
     * Rendered verbatim as the conversation-context value. A provider that
     * substitutes template variables passes its own syntax (for example
     * `{{initialConversationContext}}`); omitting it drops the section.
     */
    initialConversationContextPlaceholder?: string;
    /** Rendered verbatim as the active session id, same ownership as above. */
    sessionIdPlaceholder?: string;
    disabledActionIds?: readonly string[];
    extraSystemAppendBlocks?: readonly string[];
    availableToolNames?: readonly string[];
    assistantLanguage?: string | null;
    welcome?: Readonly<{ enabled: boolean; mode: 'immediate' | 'on_first_turn' }>;
    actionSpecs?: readonly Pick<
        ActionSpec,
        'id' | 'title' | 'description' | 'bindings' | 'examples' | 'inputHints' | 'prompting'
    >[];
}>;

/**
 * The host's canonical system prompt for a realtime Voice provider that exposes
 * Happier actions to the model as client tools. Provider template syntax stays
 * with the provider: the placeholders are rendered verbatim.
 */
export const buildVoiceClientToolAgentPrompt: (
    options?: VoiceClientToolAgentPromptOptions,
) => string = /* @__PURE__ */ projectProtocolValue(canonicalBuildVoiceClientToolAgentPrompt);

export const VoiceRealtimeJsonValueSchema: VoiceSchema<VoiceRealtimeJsonValue> = canonicalVoiceRealtimeJsonValueSchema;
export const VoiceRealtimeToolCallV1Schema: VoiceSchema<VoiceRealtimeToolCall> = canonicalVoiceRealtimeToolCallV1Schema;
export const VoiceRealtimeToolResultV1Schema: VoiceSchema<VoiceRealtimeToolResult> = canonicalVoiceRealtimeToolResultV1Schema;

/** Project an already-redacted host result into the provider's tool-output JSON. */
export const projectVoiceRealtimeToolResultOutput: (result: VoiceRealtimeToolResult) => VoiceRealtimeJsonValue =
    /* @__PURE__ */ projectProtocolValue(canonicalProjectVoiceRealtimeToolResultOutput);

export type {
    VoiceClientAuthArtifact,
} from '@happier-dev/protocol/voice/providerOperations';
export type {
    VoiceTranscriptLadderMapper,
    VoiceTranscriptLadderMode,
    VoiceTranscriptLadderObservation,
} from '@happier-dev/protocol/voice/realtime';

/**
 * Fold a realtime provider's per-item transcript ladder (interim fragments and
 * updates, then one or more superseding authoritative finals) into the
 * canonical transcript event stream the host projector consumes.
 *
 * The host owns the rule that a superseding transcript for the same provider
 * item corrects that row instead of appending another one. A provider leaf only
 * classifies its native event types into a {@link VoiceTranscriptLadderMode}
 * and supplies the provider's own item and event identities.
 */
export const createVoiceTranscriptLadderMapper: (
    options?: Readonly<{ maxItems?: number }>,
) => VoiceTranscriptLadderMapper = canonicalCreateVoiceTranscriptLadderMapper;

export const HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE: string =
    canonicalHappierVoiceBindingNonceDynamicVariable;
export const HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE: string =
    canonicalHappierVoiceLeaseIdDynamicVariable;
export const VoiceTranscriptCanonicalEventV1Schema: VoiceSchema<VoiceTranscriptCanonicalEvent> = canonicalVoiceTranscriptCanonicalEventV1Schema;
export type {
    VoiceRealtimeJsonValue,
    VoiceRealtimeToolCallV1 as VoiceRealtimeToolCall,
    VoiceRealtimeToolResultV1 as VoiceRealtimeToolResult,
    VoiceTranscriptCanonicalEventV1 as VoiceTranscriptCanonicalEvent,
} from '@happier-dev/protocol/voice/realtime';
export type VoiceTranscriptCanonicalEventV1 = VoiceTranscriptCanonicalEvent;
export type VoiceRealtimeToolResultV1 = VoiceRealtimeToolResult;

export type VoiceRealtimeConnectionCloseReason = Readonly<{
    code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error';
    detail?: string;
}>;
export type VoiceOutputInterruptionResolution = 'false_alarm' | 'confirmed';
/** A natural audible drain is distinct from clear, interruption and teardown. */
export type VoiceOutputDrainResult = 'completed' | 'cancelled';
/** Capture before requesting host speech, so earlier clear/mute cannot look like a natural drain. */
export type VoiceOutputPlayback = Readonly<{
    waitForDrain(signal: AbortSignal): Promise<VoiceOutputDrainResult>;
}>;
export type VoiceHostTextPlayback = (input: Readonly<{
    text: string;
    signal: AbortSignal;
}>) => Promise<
    | Readonly<{ status: 'completed' | 'cancelled' }>
    | Readonly<{ status: 'unavailable'; code: 'host_text_playback_unavailable' }>
>;
/**
 * Host-owned audio-focus policy for one connection's provider-neutral output.
 * `suspended` keeps the connection and attempt alive while making its output
 * inaudible; it is not a provider turn-cancellation instruction.
 */
export type VoiceOutputFocusState = 'active' | 'ducked' | 'suspended';
export type VoiceOutputFocusApplication = 'applied' | 'unsupported';

export type VoiceRealtimeConnection = Readonly<{
    readonly kind: 'websocket_pcm' | 'webrtc' | 'sdk_handle';
    connect(signal: AbortSignal): Promise<void>;
    sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
    controlEvents(signal: AbortSignal): AsyncIterable<VoiceRealtimeJsonValue>;
    transportEvents(signal: AbortSignal): AsyncIterable<
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
        }>
    >;
    close(reason: VoiceRealtimeConnectionCloseReason): Promise<void>;
    state(): 'idle' | 'connecting' | 'open' | 'closed';
    currentProviderSessionId(): string | null;
    playbackCursorMs(): number | null;
    beginOutputInterruptionCandidate(): 'retained' | 'ducked' | 'unsupported';
    resolveOutputInterruptionCandidate(resolution: VoiceOutputInterruptionResolution): void;
    /**
     * Applies the host's current audio-focus policy. Implementations must retain
     * a non-active state until a late media/output attachment is available.
     */
    setOutputFocusState?(state: VoiceOutputFocusState): VoiceOutputFocusApplication;
}>;

export type VoiceSdkHandleConnectionDriver = Readonly<{
    open(input: Readonly<{
        signal: AbortSignal;
        onControl(event: unknown): void;
        onTransport(
            event: ReturnType<VoiceRealtimeConnection['transportEvents']> extends AsyncIterable<infer TEvent>
                ? TEvent
                : never,
        ): void;
        onRemoteClose(reason: string): void;
    }>): Promise<void>;
    sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
    beginOutputInterruptionCandidate?(): ReturnType<VoiceRealtimeConnection['beginOutputInterruptionCandidate']>;
    resolveOutputInterruptionCandidate?(resolution: VoiceOutputInterruptionResolution): void;
    setOutputFocusState?(state: VoiceOutputFocusState): void;
    close(reason: VoiceRealtimeConnectionCloseReason): Promise<void>;
}>;

export type VoiceConnectionMediaHost = Readonly<{
    createSdkHandleConnection(input: Readonly<{
        driver: VoiceSdkHandleConnectionDriver;
    }>): VoiceRealtimeConnection;
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
    }>): VoiceRealtimeConnection;
    createPcmConnection(input: Readonly<{
        driver: VoiceSdkHandleConnectionDriver;
        input: Readonly<{ sampleRate: number; chunkMs: number }>;
        output: Readonly<{ sampleRate: number }>;
        onInputChunk(base64Pcm16Le: string): void;
        onInputError?(code:
            | 'pcm_capture_backpressure'
            | 'pcm_capture_chunk_failed'
            | 'pcm_capture_device_lost'
            | 'pcm_capture_invalid_chunk'
            | 'pcm_capture_media_source_failed'
            | 'pcm_capture_mic_acquisition_failed'
            | 'pcm_capture_mic_state_unavailable'
            | 'pcm_capture_resume_failed'
            | 'pcm_capture_unavailable'
        ): void;
    }>): Readonly<{
        connection: VoiceRealtimeConnection;
        enqueueOutput(base64Pcm16Le: string): boolean;
        clearOutput(): void;
        /** Older media hosts return void, which is never proof of completion. */
        waitForOutputDrain(signal: AbortSignal): Promise<VoiceOutputDrainResult | void>;
        captureOutputPlayback?(): VoiceOutputPlayback;
    }>;
}>;

/**
 * Opaque host-owned microphone stream identity.
 *
 * The client contract is shared by web and React Native providers, so it must
 * not require browser DOM declarations. Providers hand capture to
 * {@link VoiceConnectionMediaHost}; they do not own or mutate the underlying
 * platform stream through this handle.
 */
export type VoiceMediaStreamHandle = object;

/**
 * Opaque host-owned audio-context identity. Browser implementations may retain
 * a native `AudioContext`, while native implementations normally return null.
 */
export type VoiceAudioContextHandle = object;

export type VoiceMicSession = Readonly<{
    ensureActive(): Promise<void>;
    setMuted(muted: boolean): void;
    isMuted(): boolean;
    teardown(): Promise<void>;
    getStream(): VoiceMediaStreamHandle | null;
    getAudioContext?(): VoiceAudioContextHandle | null;
}>;

/**
 * The single host-selected microphone/capture authority for one realtime
 * conversation attempt. Providers declare this before connection creation so
 * the host never has to infer capture ownership from a late transport choice.
 */
export type VoiceMicrophoneMode = 'host_webrtc' | 'host_pcm' | 'provider_managed';

export type VoiceRealtimePreflight =
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'declined'; code: string }>
    | Readonly<{ kind: 'aborted' }>;

export type VoiceRealtimePreparation =
    | Readonly<{
        kind: 'prepared';
        session: Readonly<{
            config: VoiceRealtimeJsonValue;
            safeMetadata: VoiceRealtimeJsonValue;
            /**
             * The startup config already carries the request's initial context.
             * The host skips its post-connect context update for this carrier;
             * omission retains host delivery. Later context updates are unchanged.
             */
            initialContextDelivery?: 'prepared';
            /** This admitted carrier requires an explicit input commit rather than automatic VAD. */
            inputCommitRequired?: boolean;
        }>;
    }>
    | Readonly<{ kind: 'declined'; code: string }>
    | Readonly<{ kind: 'aborted' }>;

export type VoiceTurnControlAction =
    | 'cancel_response'
    | 'truncate_playback'
    | 'clear_input'
    | 'commit_input'
    | 'stop_session'
    | 'resume_session'
    | 'send_exact_message';

export type VoiceRealtimeCanonicalEvent =
    | Readonly<{ type: 'auth_expired' }>
    | Readonly<{
        type: 'provider_error';
        code:
            | 'rate_limited'
            | 'provider_response_invalid'
            | 'voice_session_expired'
            | 'voice_transcription_failed'
            | 'voice_tool_result_delivery_unrecoverable'
            | 'voice_service_unavailable'
            | 'voice_provider_agent_unavailable'
            | 'voice_response_incomplete';
        /** Content-free provider diagnostic code; never a message or payload. */
        providerCode?: string;
        /** Producer-projected content-free cause; never vendor messages or tool output. */
        failureCause?: import('@happier-dev/protocol/actions/actionExecutionResult').ActionFailureCauseV1;
        /** End the host attempt and offer recovery, even if the provider socket remains usable. */
        terminal: boolean;
    }>
    | Readonly<{ type: 'input_speech_started' }>
    | Readonly<{ type: 'input_speech_stopped' }>
    | Readonly<{ type: 'input_audio_committed'; itemId: string }>
    | Readonly<{
        type: 'input_transcript_finished';
        /** Audio-commit correlation, absent when the SDK exposes only a finished microphone turn. */
        itemId?: string;
    }>
    | Readonly<{ type: 'response_created'; responseId: string }>
    | Readonly<{ type: 'response_finished'; responseId: string }>
    | Readonly<{ type: 'assistant_output_started'; itemId?: string }>
    | Readonly<{ type: 'assistant_output_stopped' }>
    | Readonly<{ type: 'transcript'; event: VoiceTranscriptCanonicalEvent }>
    | Readonly<{
        type: 'tool_calls';
        /** Independent response identity; omitted when the vendor exposes only call identities. */
        responseId?: string;
        calls: readonly VoiceRealtimeToolCall[];
    }>;

/**
 * The platforms a Voice **client runtime** actually runs on.
 *
 * Deliberately narrower than Protocol's `VoiceRuntimePlatform`, which enumerates the platforms a
 * contribution may *declare* support for (desktop included). The host collapses every desktop shell
 * to `web` because that is the bundle it loads, so widening this union would make plugin authors
 * handle cases the host cannot produce. `voice/contract.test.ts` holds it to a canonical subset.
 */
export type VoiceRuntimePlatform = 'web' | 'ios' | 'android';

export type VoiceClientToolDefinition = Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
    /**
     * Attempt-scoped direct read boundary. The host owns policy, execution,
     * privacy redaction, and stale-attempt fencing; provider leaves only adapt
     * the already-sanitized result to their native SDK.
     *
     * Effectful Action definitions reject here because a direct callback has no
     * stable response/call identity. Providers deliver those through canonical
     * `tool_calls`, where the host barrier owns authorization, settlement,
     * cancellation, and deduplication under the actual tool-call id.
     */
    execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue>;
}>;

/**
 * Attempt-scoped access to the host-owned provider conversation identity.
 * The host owns session binding, durable storage, mutation ordering, and stale
 * attempt fencing; the provider owns only its native identity wire semantics.
 */
export type VoiceProviderConversationService = Readonly<{
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
export type VoiceHostedConversationService = Readonly<{
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

/**
 * Attempt-scoped, already-session-bound Voice authority for Agent realtime
 * negotiation. Session and Agent selection remain host-owned.
 */
export type PluginVoiceAgentSessionRealtimeService = Readonly<{
    inspect(
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeAvailability>;
    start(
        input: AgentSessionRealtimeStartInput,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeStartResult>;
}>;

export type VoiceProviderExecutionAuthority =
    | Readonly<{
        kind: 'direct_media';
    }>
    | Readonly<{
        kind: 'experimental_agent_session_realtime';
        agentSessionRealtime: PluginVoiceAgentSessionRealtimeService;
    }>;

export type RealtimeVoiceProviderProtocol = Readonly<{
    preflight?(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        request: VoiceRealtimeJsonValue;
        platform: VoiceRuntimePlatform;
        providerConfig: VoiceRealtimeJsonValue;
        signal: AbortSignal;
    }>): Promise<VoiceRealtimePreflight>;
    prepare(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        reason: 'initial' | 'reconnect' | 'auth_refresh';
        request: VoiceRealtimeJsonValue;
        platform: VoiceRuntimePlatform;
        providerConfig: VoiceRealtimeJsonValue;
        credentials: VoiceCredentialAccess<'prepare'>;
        /** Host-composed standalone policy. Attached Agent sessions own their native prompt. */
        attemptPolicy?: VoiceRealtimeAttemptPolicy;
        providerConversation: VoiceProviderConversationService | null;
        hostedConversation: VoiceHostedConversationService | null;
        signal: AbortSignal;
    }>): Promise<VoiceRealtimePreparation>;
    decodeControl(event: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[];
    encodeTurnControl(
        action: VoiceTurnControlAction,
        payload?: VoiceRealtimeJsonValue,
    ): VoiceRealtimeJsonValue | null;
    /** Native continuation after input commit; the host retains exact connection custody. */
    encodePostInputCommitControls?(): readonly VoiceRealtimeJsonValue[];
    refreshAuth?(signal: AbortSignal): Promise<boolean>;
    releasePrepared?(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        reason: VoiceRealtimeConnectionCloseReason;
    }>): Promise<void> | void;
}>;

/** Immutable host policy for one standalone Voice attempt; never safe metadata. */
export type VoiceRealtimeAttemptPolicy = Readonly<{
    instructions: string;
    assistantLanguage: string | null;
    welcome: Readonly<{
        enabled: boolean;
        mode: 'immediate' | 'on_first_turn';
        /** Host-composed literal in the admitted reply language, when available. */
        text?: string;
    }>;
}>;

export type RealtimeVoiceProviderSettingsOperations = Readonly<{
    listCatalog?(
        input: Readonly<{
            catalog: 'voices' | 'models';
            providerConfig: VoiceRealtimeJsonValue;
            credentials: VoiceCredentialAccess<'settings'>;
            signal: AbortSignal;
        }>,
    ): Promise<readonly VoiceRealtimeJsonValue[]>;
}>;

/**
 * A provider that owns input capture must expose the operation that applies
 * the host-owned mute state to that capture. Host-capture modes may opt into
 * the same operation for a provider-native secondary input path.
 */
export type RealtimeVoiceProviderRuntime = Readonly<{
    kind: 'conversation';
    protocol: RealtimeVoiceProviderProtocol;
    settingsOperations?: RealtimeVoiceProviderSettingsOperations;
    createConnection(input: Readonly<{
        session: Extract<VoiceRealtimePreparation, Readonly<{ kind: 'prepared' }>>['session'];
        attemptId: number;
        mic: VoiceMicSession;
        interruption: Readonly<{ duckGain: number; retainedOutputMaxMs: number }>;
        levels: Readonly<{ onOutputLevel(level: number): void }>;
        media: VoiceConnectionMediaHost;
        tools: readonly VoiceClientToolDefinition[];
        ui: PluginUiHostApi;
        signal: AbortSignal;
        execution: VoiceProviderExecutionAuthority;
        credentials: VoiceCredentialAccess<'connection'>;
        /** Notify immediately before provider-owned greeting or host-readback input opens a response. */
        onSyntheticResponseRequested?: () => void;
    }>): Promise<VoiceRealtimeConnection>;
    encodeToolResults(results: readonly VoiceRealtimeToolResult[]): readonly VoiceRealtimeJsonValue[];
    encodeToolContinuation(responseId: string): VoiceRealtimeJsonValue;
    beforeToolContinuation?(responseId: string, signal: AbortSignal): Promise<void>;
    /** Verbatim host text; completed means this utterance actually finished playing. */
    playHostText?: VoiceHostTextPlayback;
    beforeInterrupt?(): Promise<void> | void;
    forgetProviderConversation?(): Promise<void>;
    dispose?(): Promise<void> | void;
    encodePostCancelControls?(): readonly VoiceRealtimeJsonValue[];
    encodePostBargeInControls?(): readonly VoiceRealtimeJsonValue[];
    encodeContextUpdate(text: string): readonly VoiceRealtimeJsonValue[];
    /**
     * Encode one typed user turn. Element zero is the user-input acceptance
     * control; later elements may continue/start the provider response. The
     * host persists the accepted user row between those two phases.
     */
    encodeTextTurn(text: string): readonly VoiceRealtimeJsonValue[];
    outputLevelMeter?: 'measured' | 'unavailable';
}> & (
    | Readonly<{
        microphoneMode: 'provider_managed';
        setInputMuted(muted: boolean): Promise<void> | void;
    }>
    | Readonly<{
        microphoneMode: 'host_webrtc' | 'host_pcm';
        setInputMuted?(muted: boolean): Promise<void> | void;
    }>
);
