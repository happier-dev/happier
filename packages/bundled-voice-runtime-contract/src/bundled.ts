import type {
  ConnectedServiceBindingsV1,
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolResultV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionRealtimeLifecycleEvent,
  PluginVoiceAgentSessionRealtimeService,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import type {
  PluginVoiceProviderExecutionAuthority,
} from '@happier-dev/plugin-sdk/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import type {
  CreateVoiceConversationController,
  VoiceConversationToolBarrier,
} from './controller.js';
import type {
  VoiceConnectionDriver,
  VoicePcmConnectionMedia,
  VoiceHostNegotiatedWebRtcInput,
  VoiceNegotiatedWebRtcInput,
  VoiceRealtimeConnection,
} from './connection.js';
import type { VoiceRealtimeProtocolAdapter } from './protocol.js';
import type {
  BundledVoiceRuntimeContribution,
  VoiceAdapterConversationBinding,
  VoiceAdapterSurfaceCapabilities,
  VoiceMachineError,
  VoiceMachineErrorKind,
  VoiceSessionSnapshot,
} from './session.js';

export type BundledVoiceMicSession = Readonly<{
  ensureActive(): Promise<void>;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  teardown(): Promise<void>;
  getStream(): MediaStream | null;
  getAudioContext?(): AudioContext | null;
}>;

export type BundledVoicePcmCaptureError =
  | 'web_pcm_capture_backpressure'
  | 'web_pcm_capture_chunk_failed'
  | 'web_pcm_capture_device_lost'
  | 'web_pcm_capture_invalid_chunk'
  | 'web_pcm_capture_media_source_failed'
  | 'web_pcm_capture_mic_acquisition_failed'
  | 'web_pcm_capture_mic_state_unavailable'
  | 'web_pcm_capture_resume_failed'
  | 'web_pcm_capture_unavailable';

export type BundledVoicePcmMediaController = Readonly<{
  pcm: VoicePcmConnectionMedia;
  enqueueOutput(base64Pcm16Le: string): boolean;
  clearOutput(): void;
  waitForOutputDrain(signal: AbortSignal): Promise<void>;
}>;

export type BundledVoicePcmConnection = Readonly<{
  connection: VoiceRealtimeConnection;
  enqueueOutput(base64Pcm16Le: string): boolean;
  clearOutput(): void;
  waitForOutputDrain(signal: AbortSignal): Promise<void>;
}>;

export type BundledVoiceProviderMediaPort = Readonly<{
  createSdkHandleConnection(input: Readonly<{
    driver: VoiceConnectionDriver;
  }>): VoiceRealtimeConnection;
  createWebRtcConnection(input: Readonly<{
    signaling: VoiceNegotiatedWebRtcInput['signaling'];
    control: VoiceNegotiatedWebRtcInput['control'];
  }>): VoiceRealtimeConnection;
  createPcmConnection(input: Readonly<{
    driver: VoiceConnectionDriver;
    input: Readonly<{ sampleRate: number; chunkMs: number }>;
    output: Readonly<{ sampleRate: number; maxBufferedMs: number }>;
    onInputChunk(base64Pcm16Le: string): void;
    onInputError?(code: BundledVoicePcmCaptureError): void;
  }>): BundledVoicePcmConnection;
}>;

export type BundledVoiceRuntimeMachinePort = Readonly<{
  transitionToAcquiringMic(controlSessionId: string, adapterId: string): void;
  transitionToConnecting(controlSessionId: string, adapterId: string): void;
  setReconnecting(controlSessionId: string, adapterId: string, reconnecting: boolean): void;
  transitionToConnected(controlSessionId: string, adapterId: string): void;
  transitionToSpeaking(controlSessionId: string, adapterId: string): void;
  transitionToEnding(controlSessionId: string, adapterId: string): void;
  transitionToDisconnected(controlSessionId: string, adapterId: string, error: unknown | null): void;
  setError(controlSessionId: string, adapterId: string, error: unknown): void;
  setMuted(muted: boolean): void;
  getSnapshot(): unknown;
  projectSnapshot(adapterId: string, snapshot: unknown): VoiceSessionSnapshot;
  subscribe(listener: () => void): () => void;
}>;

export type BundledVoiceProviderDiagnosticEvent = Readonly<{
  providerId: 'realtime_elevenlabs';
  eventType:
    | 'agent_chat_response_part'
    | 'agent_response'
    | 'agent_response_correction'
    | 'agent_tool_response'
    | 'audio'
    | 'client_tool_call'
    | 'conversation_initiation_metadata'
    | 'elevenlabs.connect'
    | 'elevenlabs.mode'
    | 'elevenlabs.status'
    | 'guardrail_triggered'
    | 'interruption'
    | 'unknown'
    | 'user_transcript';
  payloadBytes: number | null;
  redactionClass: 'control' | 'transcript_redacted' | 'unknown_redacted';
}>;

export type BundledRealtimeProviderRuntimeHost = Readonly<{
  globalVoiceSessionId: string;
  getPlatform(): 'web' | 'ios' | 'android';
  getRealtimeClientToolDefinitions(): readonly Readonly<{
    name: string;
    description: string;
    parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
    execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue>;
  }>[];
  getSettings(): unknown;
  projectVoiceSettings(settings: unknown, providerId: string): Readonly<{
    providerId: string | null;
    providerConfig: unknown;
  }> | null;
  machine: BundledVoiceRuntimeMachinePort;
  createConversationController: CreateVoiceConversationController;
  createMicSession(input: Readonly<{
    onFailure(failure: Readonly<{ kind: VoiceMachineErrorKind; reason: string }>): void;
    onLevel(level: number): void;
  }>): BundledVoiceMicSession;
  createSdkHandleConnection(input: Readonly<{
    driver: VoiceConnectionDriver;
  }>): VoiceRealtimeConnection;
  createWebRtcConnection(input: VoiceHostNegotiatedWebRtcInput): VoiceRealtimeConnection;
  createAgentSessionRealtimeService?(input: Readonly<{
    provider: Readonly<{ pluginId: string; localId: string }>;
    agent: Readonly<{ pluginId: string; localId: string }>;
    adapterId: string;
    controlSessionId: string;
    applicationAttemptId: string;
    signal: AbortSignal;
    onTerminal(event: AgentSessionRealtimeLifecycleEvent): void;
  }>): Promise<PluginVoiceAgentSessionRealtimeService | null>;
  createWebSocketPcmMedia(input: Readonly<{
    mic: BundledVoiceMicSession;
    input: Readonly<{ sampleRate: number; chunkMs: number }>;
    output: Readonly<{
      sampleRate: number;
      maxBufferedMs: number;
      retainedOutputMaxMs: number;
    }>;
    onInputChunk(base64Pcm16Le: string): void;
    onInputError?(code: BundledVoicePcmCaptureError): void;
    onOutputLevel(level: number): void;
  }>): BundledVoicePcmMediaController;
  createWebSocketPcmConnection(input: Readonly<{
    driver: VoiceConnectionDriver;
    pcm: VoicePcmConnectionMedia;
  }>): VoiceRealtimeConnection;
  ensureBound(input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    requestedTargetSessionId: string | null;
  }>): Promise<unknown>;
  acquireDirectMediaConversation(input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    requestedTargetSessionId: string | null;
  }>):
    | Readonly<{ conversationSessionId: string }>
    | Promise<Readonly<{ conversationSessionId: string }>>;
  releaseDirectMediaConversation(input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
  }>): void;
  resolveConversationSessionId(controlSessionId: string, adapterId: string): string | null;
  canPersistProviderConversationState?(input: Readonly<{
    providerId: string;
    conversationSessionId: string;
  }>): boolean;
  resolveAgentRealtimeVoiceConversationBinding?(input: Readonly<{
    provider: Readonly<{ pluginId: string; localId: string }>;
    agent: Readonly<{ pluginId: string; localId: string }>;
    controlSessionId: string;
    requestedTargetSessionId: string | null;
    settings: unknown;
    connectedServices?: ConnectedServiceBindingsV1;
  }>): Promise<VoiceAdapterConversationBinding | null>;
  readProviderConversationState?(input: Readonly<{
    providerId: string;
    conversationSessionId: string;
  }>): Promise<Readonly<{ conversationId: string }> | null>;
  writeProviderConversationState?(input: Readonly<{
    providerId: string;
    conversationSessionId: string;
    state: Readonly<{ conversationId: string }> | null;
  }>): Promise<void>;
  applyTargetSelection(input: Readonly<{
    controlSessionId: string;
    targetSessionId: string;
    updateLastFocused: boolean;
  }>): Promise<void>;
  acquireAudioMode(ownerId: string): Promise<Readonly<{ release(): Promise<void> }>>;
  createStorageMirror(input: Readonly<{
    adapterId: string;
    getSnapshot(): unknown;
    subscribe(listener: () => void): () => void;
    projectSnapshot(snapshot: unknown): Readonly<{
      status: 'disconnected' | 'connecting' | 'connected' | 'error';
      mode: 'idle' | 'speaking';
    }>;
  }>): () => void;
  openLevelWriter(input: Readonly<{
    channel: 'input' | 'output';
    sourceId: string;
  }>): Readonly<{
    write(level: number): void;
    reset(): void;
    close(): void;
  }>;
  projectTranscript(input: Readonly<{
    conversationSessionId: string;
    event: VoiceTranscriptCanonicalEventV1;
    source?: Readonly<{
      pluginId: string;
      contributionId: string;
    }>;
  }>): string | null;
  beginTranscriptAttempt(input: Readonly<{
    conversationSessionId: string;
  }>): number | null;
  presentHostedLeaseNotice(input: Readonly<{
    controlSessionId: string;
    providerId: string;
    phase: 'started' | 'expiring' | 'expired';
    remainingMs: number;
  }>): void;
  presentAttemptDiagnostic(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    diagnostic: PluginDiagnosticData;
  }>): void;
  clearAttemptStatus(controlSessionId: string): void;
  diagnostics?: Readonly<{
    appendSystem(message: string): void;
    appendProviderEvent(event: BundledVoiceProviderDiagnosticEvent): void;
    appendError(reason: string): void;
  }>;
  createToolBarrier(input: Readonly<{
    resolveSessionId(explicitSessionId?: string | null): string | null;
    submitResults(
      responseId: string,
      results: readonly VoiceRealtimeToolResultV1[],
      signal: AbortSignal,
    ): Promise<void>;
    continueResponse(responseId: string, signal: AbortSignal): Promise<void>;
  }>): VoiceConversationToolBarrier;
  voiceHooks: Readonly<{
    onStarted(sessionId: string): string;
    onStopped(): void;
  }>;
  createMachineError(input: Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
  }>): VoiceMachineError;
}>;

export type BundledRealtimeProviderRuntimeConfig = Readonly<{
  providerId: string;
  providerSource?: Readonly<{
    pluginId: string;
    contributionId: string;
  }>;
  execution:
    | Readonly<{ kind: 'direct_media' }>
    | Readonly<{
        kind: 'experimental_agent_session_realtime';
        provider: Readonly<{ pluginId: string; localId: string }>;
        agent: Readonly<{ pluginId: string; localId: string }>;
      }>;
  protocol: VoiceRealtimeProtocolAdapter;
  createConnection(input: Readonly<{
    controlSessionId: string;
    session: Readonly<{
      config: VoiceRealtimeJsonValue;
      safeMetadata: VoiceRealtimeJsonValue;
    }>;
    attemptId: number;
    mic: BundledVoiceMicSession;
    interruption: Readonly<{ duckGain: number; retainedOutputMaxMs: number }>;
    levels: Readonly<{ onOutputLevel(level: number): void }>;
    media: BundledVoiceProviderMediaPort;
    signal: AbortSignal;
    execution: PluginVoiceProviderExecutionAuthority;
  }>): Promise<VoiceRealtimeConnection>;
  encodeToolResults(results: readonly VoiceRealtimeToolResultV1[]): readonly VoiceRealtimeJsonValue[];
  encodeToolContinuation(responseId: string): VoiceRealtimeJsonValue;
  beforeToolContinuation?(responseId: string, signal: AbortSignal): Promise<void>;
  beforeInterrupt?(): Promise<void> | void;
  encodePostCancelControls?(): readonly VoiceRealtimeJsonValue[];
  encodePostBargeInControls?(): readonly VoiceRealtimeJsonValue[];
  runtimeActions?: Readonly<Record<string, () => Promise<void>>>;
  requiresMicForConnection?: boolean;
  setInputMuted?(muted: boolean): Promise<void> | void;
  encodeContextUpdate(text: string): readonly VoiceRealtimeJsonValue[];
  encodeTextTurn(text: string): readonly VoiceRealtimeJsonValue[];
  resolveConversationBinding?(input: Readonly<{
    controlSessionId: string;
    requestedTargetSessionId: string | null;
    settings: unknown;
  }>): Promise<VoiceAdapterConversationBinding | null>;
  resolveSurfaceCapabilities(settings: unknown): VoiceAdapterSurfaceCapabilities | null;
  outputLevelMeter?: 'measured' | 'unavailable';
}>;

export type CreateBundledRealtimeProviderRuntime = (
  host: BundledRealtimeProviderRuntimeHost,
  config: BundledRealtimeProviderRuntimeConfig,
) => BundledVoiceRuntimeContribution;

/** Factory exposed by the app host to a bundled first-party provider entry. */
export type CreateBundledRealtimeProviderRuntimeContribution = (
  config: BundledRealtimeProviderRuntimeConfig,
) => BundledVoiceRuntimeContribution;
