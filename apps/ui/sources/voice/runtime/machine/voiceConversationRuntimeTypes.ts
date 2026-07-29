import type {
    VoiceAdapterId,
    VoiceMachineError,
} from '@happier-dev/bundled-voice-runtime-contract';

export type {
    VoiceMachineError,
    VoiceMachineErrorKind,
    VoiceMachineErrorPhase,
    VoiceMachineErrorPresentation,
    VoiceMachineRecoveryAction,
    VoiceMachineRetryPolicy,
} from '@happier-dev/bundled-voice-runtime-contract';

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
     * `realtime_elevenlabs`) means a non-local adapter owns the lifecycle. The
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
