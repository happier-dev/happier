export type VoiceConversationRuntimeState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'acquiring_mic'
    | 'listening'
    | 'transcribing'
    | 'sending'
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
    controlSessionId: string | null;
    state: VoiceConversationRuntimeState;
    micMuted: boolean;
    error: VoiceMachineError | null;
}>;
