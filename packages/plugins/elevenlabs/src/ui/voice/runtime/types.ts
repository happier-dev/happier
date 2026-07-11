import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolCallV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

export type ConnectionCloseReason = Readonly<{
  code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error';
  detail?: string;
}>;

export type RealtimeTransportEvent = Readonly<{ type: string } & Record<string, unknown>>;

export type RealtimeConnection = Readonly<{
  kind: 'sdk_handle';
  connect(signal: AbortSignal): Promise<void>;
  sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
  controlEvents(signal: AbortSignal): AsyncIterable<VoiceRealtimeJsonValue>;
  transportEvents(signal: AbortSignal): AsyncIterable<RealtimeTransportEvent>;
  close(reason: ConnectionCloseReason): Promise<void>;
  state(): 'idle' | 'connecting' | 'open' | 'closed';
  currentProviderSessionId(): string | null;
}>;

export type PreparedSession = Readonly<{
  config: VoiceRealtimeJsonValue;
  safeMetadata: VoiceRealtimeJsonValue;
}>;

export type ProtocolPreparation =
  | Readonly<{ kind: 'prepared'; session: PreparedSession }>
  | Readonly<{ kind: 'declined'; code: string }>
  | Readonly<{ kind: 'aborted' }>;

export type CanonicalEvent =
  | Readonly<{ type: 'provider_event'; event: VoiceRealtimeJsonValue }>
  | Readonly<{ type: 'auth_expired' }>
  | Readonly<{ type: 'transcript'; event: VoiceTranscriptCanonicalEventV1 }>
  | Readonly<{ type: 'tool_calls'; responseId: string; calls: readonly VoiceRealtimeToolCallV1[] }>;

export type ProtocolAdapter = Readonly<{
  id: string;
  turnControls: Readonly<{
    cancelResponse: 'unsupported';
    truncatePlayback: 'unsupported';
    clearInput: false;
    stopSession: true;
    resumption: 'none';
    replay: 'none';
    exactMessage: true;
  }>;
  prepare(input: Readonly<{
    controlSessionId: string;
    reason: 'initial' | 'reconnect' | 'auth_refresh';
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>): Promise<ProtocolPreparation>;
  decodeControl(event: VoiceRealtimeJsonValue): readonly CanonicalEvent[];
  encodeTurnControl(action: string, payload?: VoiceRealtimeJsonValue): VoiceRealtimeJsonValue | null;
  refreshAuth?: (signal: AbortSignal) => Promise<boolean>;
  releasePrepared?: (input: Readonly<{ controlSessionId: string; reason: ConnectionCloseReason }>) => Promise<void> | void;
}>;

export type ControllerMachinePort = Readonly<{
  connecting(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  connected(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  ending(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  disconnected(input: Readonly<{ controlSessionId: string; attemptId: number; code?: string }>): void;
  failed(input: Readonly<{ controlSessionId: string; attemptId: number; code: string }>): void;
}>;

export type ConversationController = Readonly<{
  start(input: Readonly<{ controlSessionId: string; request: VoiceRealtimeJsonValue }>): Promise<Readonly<{ status: string; code?: string }>>;
  stop(input?: Readonly<{ code?: string; detail?: string }>): Promise<void>;
  fail(code: string): Promise<void>;
  sendClientControl(event: VoiceRealtimeJsonValue): Promise<Readonly<{ status: 'sent' | 'unavailable' }>>;
  getActiveControlSessionId(): string | null;
  getOwnedControlSessionId(): string | null;
  requestReconnect(): Promise<void>;
}>;

export type CreateConversationController = (input: Readonly<{
  adapter: ProtocolAdapter;
  machine: ControllerMachinePort;
  resources: Readonly<{
    prepare(input: Readonly<{ controlSessionId: string; attemptId: number; request: VoiceRealtimeJsonValue; signal: AbortSignal }>): Promise<void>;
    release(input: Readonly<{ controlSessionId: string; attemptId: number; reason: ConnectionCloseReason }>): Promise<void>;
  }>;
  createConnection(session: PreparedSession, attemptId: number): Promise<RealtimeConnection>;
  isSelectionCurrent(): boolean;
  projectTranscript?: (input: Readonly<{ controlSessionId: string; event: VoiceTranscriptCanonicalEventV1 }>) => void;
  onCanonicalEvent(event: CanonicalEvent, signal: AbortSignal): Promise<void>;
  sessionLifecycle: Readonly<{
    connected(input: Readonly<{ controlSessionId: string; attemptId: number; providerSessionId: string }>): Promise<void>;
    ended(input: Readonly<{ controlSessionId: string; attemptId: number; providerSessionId: string; reason: string }>): Promise<void>;
  }>;
}> ) => ConversationController;

export type VoiceAdapterSnapshot = Readonly<{
  adapterId: string | null;
  sessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  mode: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
  canStop: boolean;
  micMuted?: boolean;
  errorCode?: string;
  errorMessage?: string;
}>;

export type VoiceAdapter = Readonly<{
  id: string;
  engineKind: 'realtime';
  start(input: Readonly<{ sessionId: string; initialContext?: string; textOnly?: boolean }>): Promise<void>;
  stop(input: Readonly<{ sessionId: string }>): Promise<void>;
  toggle(input: Readonly<{ sessionId: string; initialContext?: string }>): Promise<void>;
  interrupt(input: Readonly<{ sessionId: string }>): Promise<void>;
  setMuted(input: Readonly<{ sessionId: string; muted: boolean }>): Promise<void>;
  sendContextUpdate(input: Readonly<{ sessionId: string; update: string }>): void;
  sendContextText?(input: Readonly<{ sessionId: string; text: string }>): void;
  sendTextTurn?(input: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>): Promise<void>;
  getSnapshot(): VoiceAdapterSnapshot;
  subscribe?(listener: () => void): () => void;
  resolveBindingTranscriptMode?(settings: unknown): 'synthetic' | 'native_session' | null;
  resolveSurfaceCapabilities?(voiceSettings: unknown): Readonly<{
    allowsGlobalStart: boolean;
    controlSessionScope: 'surface' | 'global';
    requiresVoiceAgentFeature: boolean;
    bargeInEnabled: boolean;
  }> | null;
  resolveContextChannel?(voiceSettings: unknown): Readonly<{
    sendContextualUpdate(update: string): void;
    sendTextMessage(text: string): void;
  }> | null;
}>;

export type ElevenLabsRuntimeContribution = Readonly<{
  adapter: VoiceAdapter;
  dispose(): Promise<void>;
}>;

export type VoiceToolResultRedactionPrefs = Readonly<{
  shareFilePaths: boolean;
  shareSessionSummary: boolean;
  sharePermissionRequests: boolean;
}>;
