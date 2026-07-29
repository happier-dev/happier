import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolCallV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

import type {
  VoiceConnectionCloseReason,
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
  VoiceRealtimeConnection,
  VoiceRealtimeTransportEvent,
} from './connection.js';
import type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreparedSession,
  VoiceRealtimeProtocolAdapter,
  VoiceTurnControlAction,
} from './protocol.js';

export type VoiceConversationToolBarrier = Readonly<{
  run(input: Readonly<{
    responseId: string;
    calls: readonly VoiceRealtimeToolCallV1[];
    signal?: AbortSignal | null;
  }>): Promise<Readonly<{ status: 'submitted' | 'cancelled' | 'failed' }>>;
  cancel(responseId: string): void;
  dispose(): void;
}>;

export type VoiceConversationControllerStartResult =
  | Readonly<{ status: 'connected' }>
  | Readonly<{ status: 'declined'; code: string }>
  | Readonly<{ status: 'aborted' }>
  | Readonly<{ status: 'failed'; code: string }>;

export type VoiceConversationControllerMachinePort = Readonly<{
  connecting(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  reconnecting?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    active: boolean;
  }>): void;
  connected(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  ending(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  disconnected(input: Readonly<{ controlSessionId: string; attemptId: number; code?: string }>): void;
  failed(input: Readonly<{ controlSessionId: string; attemptId: number; code: string }>): void;
}>;

export type VoiceConversationControllerDeps = Readonly<{
  adapter: VoiceRealtimeProtocolAdapter;
  machine: VoiceConversationControllerMachinePort;
  createConnection(
    session: VoiceRealtimePreparedSession,
    attemptId: number,
    signal: AbortSignal,
  ): Promise<VoiceRealtimeConnection>;
  isSelectionCurrent(): boolean;
  onCanonicalEvent(event: VoiceRealtimeCanonicalEvent, signal: AbortSignal): Promise<void>;
  projectTranscript?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    connectionId: number;
    event: VoiceTranscriptCanonicalEventV1;
  }>): void;
  onTransportEvent?(event: VoiceRealtimeTransportEvent, signal: AbortSignal): Promise<void>;
  onConnectionReady?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: 'initial' | 'reconnect' | 'auth_refresh';
    request: VoiceRealtimeJsonValue;
    connection: VoiceRealtimeConnection;
    signal: AbortSignal;
  }>): Promise<void>;
  createToolBarrier?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
  }>): VoiceConversationToolBarrier;
  resources?: Readonly<{
    preflight?(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      request: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): Promise<void>;
    prepare(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      request: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): Promise<void | Readonly<{ kind: 'declined'; code: string }>>;
    release(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      reason: VoiceConnectionCloseReason;
    }>): Promise<void>;
  }>;
  sessionLifecycle?: Readonly<{
    connected(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      providerSessionId: string;
    }>): Promise<void>;
    ended(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      providerSessionId: string;
      reason: VoiceConnectionCloseReason['code'] | 'reconnect';
    }>): Promise<void>;
  }>;
  waitBeforeReconnect?(attempt: number, signal: AbortSignal): Promise<void>;
  maxReconnectAttempts?: number;
  connectionReadyTimeoutMs?: number;
}>;

export type VoiceConversationController = Readonly<{
  start(input: Readonly<{
    controlSessionId: string;
    request?: VoiceRealtimeJsonValue;
  }>): Promise<VoiceConversationControllerStartResult>;
  stop(): Promise<void>;
  fail(code: string): Promise<void>;
  performTurnControl(
    action: VoiceTurnControlAction,
    payload?: VoiceRealtimeJsonValue,
  ): Promise<
    | Readonly<{ status: 'sent' }>
    | Readonly<{
        status: 'unavailable';
        code: 'voice_turn_action_unsupported' | 'voice_connection_not_open';
      }>
  >;
  sendClientControl(event: VoiceRealtimeJsonValue): Promise<
    | Readonly<{ status: 'sent' }>
    | Readonly<{ status: 'unavailable'; code: 'voice_connection_not_open' }>
  >;
  getActiveControlSessionId(): string | null;
  getOwnedControlSessionId(): string | null;
  requestReconnect(): Promise<boolean>;
  playbackCursorMs(): number | null;
  beginOutputInterruptionCandidate(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void;
}>;

export type CreateVoiceConversationController = (
  input: VoiceConversationControllerDeps,
) => VoiceConversationController;
