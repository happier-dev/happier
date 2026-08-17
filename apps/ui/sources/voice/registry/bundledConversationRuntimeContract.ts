import type {
  ConnectedServiceBindingsV1,
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolResultV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import type {
  AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  PluginVoiceAgentSessionRealtimeService,
  VoiceMicrophoneMode,
  VoiceProviderExecutionAuthority,
} from '@happier-dev/plugin-sdk/voice/client';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import type {
  CreateVoiceConversationController,
  VoiceConversationToolBarrier,
} from '@/voice/runtime/controller/VoiceConversationController';
import type {
  VoiceConnectionDriver,
  VoicePcmConnectionMedia,
  VoiceHostNegotiatedWebRtcInput,
  VoiceNegotiatedWebRtcInput,
  VoiceRealtimeConnection,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import type {
  BundledVoiceRuntimeContribution,
  VoiceAdapterConversationBinding,
  VoiceAdapterSurfaceCapabilities,
  VoiceSessionSnapshot,
} from '@/voice/session/types';
import type {
  VoiceMachineError,
  VoiceMachineErrorKind,
} from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { RealtimeInboundWatchdog } from '@/voice/runtime/realtime/realtimeInboundWatchdog';

export type BundledVoiceMicSession = Readonly<{
  /** Native host-PCM capture requests OS permission without creating a WebRTC stream. */
  ensurePermission?(): Promise<void>;
  ensureActive(): Promise<void>;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  teardown(): Promise<void>;
  getStream(): MediaStream | null;
  getAudioContext?(): AudioContext | null;
}>;

export type BundledVoicePcmCaptureError =
  | 'pcm_capture_backpressure'
  | 'pcm_capture_chunk_failed'
  | 'pcm_capture_device_lost'
  | 'pcm_capture_invalid_chunk'
  | 'pcm_capture_media_source_failed'
  | 'pcm_capture_mic_acquisition_failed'
  | 'pcm_capture_mic_state_unavailable'
  | 'pcm_capture_resume_failed'
  | 'pcm_capture_unavailable';

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

/**
 * Opaque, host-local custody for one final that was admitted while this host
 * generation was current and must finish its canonical direct-media drain
 * after a replacement takes over. The existing transcript attempt identity
 * remains the persistence owner; this only distinguishes that narrow tail
 * from a retired runtime trying to resume normal work.
 */
declare const bundledRetiringDirectMediaTranscriptDrain: unique symbol;
export type BundledRetiringDirectMediaTranscriptDrain = Readonly<{
  readonly [bundledRetiringDirectMediaTranscriptDrain]: true;
}>;

/** Host-local custody for one exact canonical persistence event admitted before a barrier. */
declare const bundledAdmittedCanonicalTranscriptPersistenceEvent: unique symbol;
export type BundledAdmittedCanonicalTranscriptPersistenceEvent = Readonly<{
  readonly [bundledAdmittedCanonicalTranscriptPersistenceEvent]: true;
}>;

/** Opaque ownership of one canonical runtime-attempt binding, never persisted. */
declare const bundledDirectMediaBindingOwnership: unique symbol;
export type BundledDirectMediaBindingOwnership = Readonly<{
  readonly [bundledDirectMediaBindingOwnership]: true;
}>;

export type BundledDirectMediaConversation = Readonly<{
  conversationSessionId: string;
  bindingOwnership?: BundledDirectMediaBindingOwnership;
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
  transitionToAcquiringMic(controlSessionId: string, adapterId: string, attemptId?: number): void;
  transitionToConnecting(controlSessionId: string, adapterId: string, attemptId?: number): void;
  setReconnecting(controlSessionId: string, adapterId: string, reconnecting: boolean, attemptId?: number): void;
  transitionToConnected(controlSessionId: string, adapterId: string, attemptId?: number): void;
  transitionToSpeaking(controlSessionId: string, adapterId: string, attemptId?: number): void;
  transitionToEnding(controlSessionId: string, adapterId: string, attemptId?: number): void;
  transitionToDisconnected(controlSessionId: string, adapterId: string, error: unknown | null, attemptId?: number): void;
  setError(controlSessionId: string, adapterId: string, error: unknown, attemptId?: number): void;
  setMuted(controlSessionId: string, adapterId: string, attemptId: number, muted: boolean): void;
  getSnapshot(): unknown;
  projectSnapshot(adapterId: string, snapshot: unknown): VoiceSessionSnapshot;
  subscribe(listener: () => void): () => void;
}>;

export type BundledRealtimeProviderRuntimeHost = Readonly<{
  globalVoiceSessionId: string;
  /** Whether this host still owns live runtime admission for its generation. */
  isCurrentGeneration?(): boolean;
  /** Atomically starts a live runtime effect and reports whether it ran. */
  runCurrentGenerationEffect(callback: () => void): boolean;
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
  /**
   * Host-owned provider-neutral inbound liveness. The production host supplies
   * this once; every bundled or external realtime contribution consumes it
   * through the same runtime composition.
   */
  createInboundWatchdog?(input: Readonly<{ onStall(): void }>): RealtimeInboundWatchdog;
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
    retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
  }>): BundledDirectMediaConversation | Promise<BundledDirectMediaConversation>;
  releaseDirectMediaConversation(input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    transcriptAttemptIdentity: string;
    retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
    bindingOwnership?: BundledDirectMediaBindingOwnership;
  }>): void | Promise<void>;
  /** Capture a current-generation final's direct-media drain before it awaits carrier recovery. */
  captureRetiringDirectMediaTranscriptDrain?(): BundledRetiringDirectMediaTranscriptDrain | null;
  releaseRetiringDirectMediaTranscriptDrain?(
    drain: BundledRetiringDirectMediaTranscriptDrain,
  ): void;
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
  forgetProviderConversationState?(input: Readonly<{
    providerId: string;
  }>): Promise<void>;
  applyTargetSelection(input: Readonly<{
    controlSessionId: string;
    targetSessionId: string;
    updateLastFocused: boolean;
  }>): Promise<void>;
  acquireAudioMode(ownerId: string): Promise<Readonly<{ release(): Promise<void> }>>;
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
    retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
  }>): string | null;
  /** Synchronously reserve one exact persistence-producing event while this generation is current. */
  admitTranscriptPersistenceEvent(input: Readonly<{
    conversationSessionId: string;
    event: VoiceTranscriptCanonicalEventV1;
    source?: Readonly<{
      pluginId: string;
      contributionId: string;
    }>;
  }>): BundledAdmittedCanonicalTranscriptPersistenceEvent | null;
  /** Consume an exact admission once; it cannot mutate a newer projector epoch. */
  commitAdmittedTranscriptPersistenceEvent(
    admission: BundledAdmittedCanonicalTranscriptPersistenceEvent,
  ): string | null;
  /** Cancel an uncommitted exact admission and release its canonical reservation. */
  releaseAdmittedTranscriptPersistenceEvent(
    admission: BundledAdmittedCanonicalTranscriptPersistenceEvent,
  ): boolean;
  settleTranscriptPersistence(input: Readonly<{
    conversationSessionId: string;
    attemptIdentity: string;
    retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
  }>): Promise<void>;
  beginTranscriptAttempt(input: Readonly<{
    conversationSessionId: string;
    retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
  }>): Readonly<{
    epoch: number;
    attemptIdentity: string;
  }> | null;
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
    execution: VoiceProviderExecutionAuthority;
  }>): Promise<VoiceRealtimeConnection>;
  encodeToolResults(results: readonly VoiceRealtimeToolResultV1[]): readonly VoiceRealtimeJsonValue[];
  encodeToolContinuation(responseId: string): VoiceRealtimeJsonValue;
  beforeToolContinuation?(responseId: string, signal: AbortSignal): Promise<void>;
  beforeInterrupt?(): Promise<void> | void;
  encodePostCancelControls?(): readonly VoiceRealtimeJsonValue[];
  encodePostBargeInControls?(): readonly VoiceRealtimeJsonValue[];
  runtimeActions?: Readonly<Record<string, () => Promise<void>>>;
  microphoneMode: VoiceMicrophoneMode;
  setInputMuted?(muted: boolean): Promise<void> | void;
  encodeContextUpdate(text: string): readonly VoiceRealtimeJsonValue[];
  /** Element zero accepts input; remaining controls continue the response. */
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
