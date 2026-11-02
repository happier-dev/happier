import type { VoiceAdapterId } from '@/voice/session/types';
import type { VoiceConversationInUseVoice } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

export type VoiceMachineErrorKind = import('@happier-dev/protocol/voice/attemptPresentation').VoiceAttemptFailureKind;

export type VoiceMachineErrorPhase = 'preflight' | 'active_session' | 'turn' | 'runtime';
export type VoiceMachineRetryPolicy = 'never' | 'user_action' | 'immediate_once' | 'backoff';
export type VoiceMachineRecoveryAction = import('@happier-dev/protocol/voice/attemptPresentation').VoiceAttemptRecoveryAction;
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
    uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
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
    /** True only while that controller has a scheduled reconnect slot to advance. */
    reconnectRetryAvailable?: boolean;
    micMuted: boolean;
    /** Teardown began without a connected runtime projection (startup, failure or disconnect). */
    endingBeforeConnect?: boolean;
    /** Speech application accepted by this attempt; pending preferences never write it. */
    inUseVoice?: VoiceConversationInUseVoice;
    preparedInstructionsFor?: SessionAddress;
    error: VoiceMachineError | null;
}>;
