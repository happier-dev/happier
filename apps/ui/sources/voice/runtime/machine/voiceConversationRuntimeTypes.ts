import type { VoiceAdapterId } from '@/voice/session/types';

export type VoiceConversationRuntimeState =
    | 'disconnected'
    | 'connecting'
    // Session open but idle with the mic off (turn-based / push-to-talk between
    // turns). Distinct from `listening` (mic hot); the turn-based local engine
    // settles here after a turn and the UI projects it as an idle session.
    | 'connected'
    | 'acquiring_mic'
    | 'listening'
    | 'transcribing'
    | 'thinking'
    | 'speaking'
    | 'interrupted'
    | 'ending'
    | 'mic_error'
    | 'error';

export type VoiceMachineErrorKind =
    | 'mic_permission_denied'
    | 'mic_ended'
    | 'mic_plateau'
    | 'transport_disconnect'
    | 'provider_error'
    | 'audio_context_suspended'
    | 'stt_timeout'
    | 'tts_failed'
    | 'turn_aborted';

export type VoiceMachineError = Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
    recoverable: boolean;
}>;

export type VoiceConversationRuntimeSnapshot = Readonly<{
    /**
     * The adapter that currently owns the runtime machine. `null` means the
     * machine is owned by a local engine adapter (local_direct/local_conversation
     * share one engine and one machine slot); a non-null id (e.g.
     * `realtime_elevenlabs`) means a non-local adapter owns the lifecycle. The
     * owner is the single source of truth used to project per-adapter session
     * snapshots so a non-owning adapter never reports another adapter's state.
     */
    adapterId: VoiceAdapterId | null;
    controlSessionId: string | null;
    state: VoiceConversationRuntimeState;
    micMuted: boolean;
    error: VoiceMachineError | null;
}>;
