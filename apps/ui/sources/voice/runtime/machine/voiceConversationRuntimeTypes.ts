import type { VoiceAdapterId } from '@/voice/session/types';

export type VoiceMachineErrorKind =
    | 'mic_permission_denied'
    | 'mic_permission_revoked'
    | 'mic_ended'
    | 'mic_plateau'
    | 'transport_disconnect'
    | 'provider_error'
    | 'provider_auth_invalid'
    | 'provider_setup_required'
    | 'reconnect_exhausted'
    | 'audio_context_suspended'
    | 'stt_timeout'
    | 'tts_failed'
    | 'turn_aborted'
    | 'authentication_required'
    | 'session_unavailable'
    | 'unsupported_runtime'
    | 'update_required'
    | 'feature_unavailable'
    | 'service_temporarily_unavailable';

export type VoiceMachineErrorPhase = 'preflight' | 'active_session' | 'turn' | 'runtime';
export type VoiceMachineRetryPolicy = 'never' | 'user_action' | 'immediate_once' | 'backoff';
export type VoiceMachineRecoveryAction =
    | 'retry'
    | 'reconnect'
    | 'open_settings'
    | 'open_settings_then_reconnect'
    | 'review_credentials'
    | 'connect_agent'
    | 'install_agent_runtime'
    | 'update_agent_runtime'
    | 'none';
export type VoiceMachineErrorPresentation =
    | 'permission_required'
    | 'notice'
    | 'error'
    | 'interrupted';

export type VoiceMachineError = Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
    phase: VoiceMachineErrorPhase;
    retryPolicy: VoiceMachineRetryPolicy;
    recoveryAction: VoiceMachineRecoveryAction;
    presentation: VoiceMachineErrorPresentation;
    recoverable: boolean;
}>;

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

export type VoiceConversationRuntimeSnapshot = Readonly<{
    /**
     * The adapter that currently owns the runtime machine. `null` means the
     * machine is owned by a local engine adapter (local_direct/local_conversation
     * share one engine and one machine slot); a non-null id (e.g.
     * `happier.voice.elevenlabs/realtime-elevenlabs`) means a non-local adapter
     * owns the lifecycle. The
     * owner is the single source of truth used to project per-adapter session
     * snapshots so a non-owning adapter never reports another adapter's state.
     */
    adapterId: VoiceAdapterId | null;
    controlSessionId: string | null;
    state: VoiceConversationRuntimeState;
    /** True only while the owning realtime controller is replacing its connection. */
    reconnecting: boolean;
    micMuted: boolean;
    error: VoiceMachineError | null;
}>;
