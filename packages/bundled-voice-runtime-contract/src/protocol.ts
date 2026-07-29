import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolCallV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';

import type { VoiceConnectionCloseReason } from './connection.js';

export type VoiceTurnControlCapabilities = Readonly<{
  cancelResponse: 'unsupported' | 'immediate';
  truncatePlayback: 'unsupported' | 'played_ms' | 'audio_samples';
  clearInput: boolean;
  stopSession: boolean;
  resumption: 'none' | 'resume';
  replay: 'none' | 'stable_ids';
  exactMessage: boolean;
}>;

export type VoiceTurnControlAction =
  | 'cancel_response'
  | 'truncate_playback'
  | 'clear_input'
  | 'stop_session'
  | 'resume_session'
  | 'replay_session'
  | 'send_exact_message';

export type VoiceRealtimePreparedSession = Readonly<{
  config: VoiceRealtimeJsonValue;
  safeMetadata: VoiceRealtimeJsonValue;
}>;

export type VoiceRealtimePreparation =
  | Readonly<{ kind: 'prepared'; session: VoiceRealtimePreparedSession }>
  | Readonly<{ kind: 'declined'; code: string }>
  | Readonly<{ kind: 'aborted' }>;

export type VoiceRealtimePreflight =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'declined'; code: string }>
  | Readonly<{ kind: 'aborted' }>;

export type VoiceRealtimeCanonicalEvent =
  | Readonly<{ type: 'auth_expired' }>
  | Readonly<{ type: 'input_speech_started' }>
  | Readonly<{ type: 'input_speech_stopped' }>
  | Readonly<{ type: 'assistant_output_started'; itemId?: string }>
  | Readonly<{ type: 'assistant_output_stopped' }>
  | Readonly<{ type: 'transcript'; event: VoiceTranscriptCanonicalEventV1 }>
  | Readonly<{
      type: 'tool_calls';
      responseId: string;
      calls: readonly VoiceRealtimeToolCallV1[];
    }>;

export type VoiceRealtimeProtocolAdapter = Readonly<{
  id: string;
  turnControls: VoiceTurnControlCapabilities;
  preflight?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>): Promise<VoiceRealtimePreflight>;
  prepare(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: 'initial' | 'reconnect' | 'auth_refresh';
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>): Promise<VoiceRealtimePreparation>;
  decodeControl(event: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[];
  encodeTurnControl(
    action: VoiceTurnControlAction,
    payload?: VoiceRealtimeJsonValue,
  ): VoiceRealtimeJsonValue | null;
  refreshAuth?(signal: AbortSignal): Promise<boolean>;
  releasePrepared?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: VoiceConnectionCloseReason;
  }>): Promise<void> | void;
}>;
