import type { VoiceAdapterEngineKind, VoiceAdapterId, VoiceSessionMode, VoiceSessionSnapshot, VoiceSessionStatus } from '@/voice/session/types';
import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';

export type LocalVoiceCompatStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

type DerivedLocalVoiceRuntimeProjection = Readonly<{
    compatStatus: LocalVoiceCompatStatus;
    sessionStatus: VoiceSessionStatus;
    sessionMode: VoiceSessionMode;
    canStop: boolean;
}>;

/**
 * A recoverable failure means "the call ended, you can retry" — the session
 * gracefully reads as `disconnected` and carries the error code/message for the
 * UI to surface, without a stop affordance. Only a non-recoverable failure is a
 * hard `error` state the user must dismiss.
 */
function isRecoverableFailure(snapshot: VoiceConversationRuntimeSnapshot): boolean {
    return snapshot.error?.recoverable === true;
}

/**
 * Project a failed/terminal runtime state through the single recoverability
 * rule. A recoverable failure reads as a graceful `disconnected` end (no stop
 * affordance, error code surfaced for the UI); a non-recoverable failure is a
 * hard `error` the user must dismiss (with no stop/retry affordance).
 *
 * This is the single owner of the recoverable→disconnected / non-recoverable→
 * error decision, shared by the machine `error`/`mic_error` states and the
 * `disconnected` state so a terminal error projects identically regardless of
 * which machine state it lands in.
 */
function resolveFailureProjection(
    snapshot: VoiceConversationRuntimeSnapshot,
): Pick<DerivedLocalVoiceRuntimeProjection, 'compatStatus' | 'sessionStatus' | 'canStop'> {
    if (isRecoverableFailure(snapshot)) {
        return { compatStatus: 'idle', sessionStatus: 'disconnected', canStop: false };
    }
    return { compatStatus: 'error', sessionStatus: 'error', canStop: false };
}

function resolveDisconnectedProjection(
    snapshot: VoiceConversationRuntimeSnapshot,
): Pick<DerivedLocalVoiceRuntimeProjection, 'compatStatus' | 'sessionStatus' | 'canStop'> {
    if (!snapshot.error) {
        return { compatStatus: 'idle', sessionStatus: 'disconnected', canStop: false };
    }
    return resolveFailureProjection(snapshot);
}

export function deriveLocalVoiceRuntimeProjection(
    snapshot: VoiceConversationRuntimeSnapshot,
): DerivedLocalVoiceRuntimeProjection {
    switch (snapshot.state) {
        case 'connecting':
            return {
                compatStatus: 'idle',
                sessionStatus: 'connecting',
                sessionMode: 'idle',
                canStop: true,
            };
        case 'acquiring_mic':
            return {
                compatStatus: 'recording',
                sessionStatus: 'connecting',
                sessionMode: 'idle',
                canStop: true,
            };
        case 'connected':
            return {
                compatStatus: 'idle',
                sessionStatus: 'connected',
                sessionMode: 'idle',
                canStop: true,
            };
        case 'listening':
            return {
                compatStatus: 'recording',
                sessionStatus: 'connected',
                sessionMode: 'listening',
                canStop: true,
            };
        case 'transcribing':
            return {
                compatStatus: 'transcribing',
                sessionStatus: 'connected',
                sessionMode: 'transcribing',
                canStop: true,
            };
        case 'thinking':
            return {
                compatStatus: 'sending',
                sessionStatus: 'connected',
                sessionMode: 'thinking',
                canStop: true,
            };
        case 'speaking':
            return {
                compatStatus: 'speaking',
                sessionStatus: 'connected',
                sessionMode: 'speaking',
                canStop: true,
            };
        case 'interrupted':
            return {
                compatStatus: 'speaking',
                sessionStatus: 'connected',
                sessionMode: 'listening',
                canStop: true,
            };
        case 'ending':
            return {
                compatStatus: 'idle',
                sessionStatus: 'connecting',
                sessionMode: 'idle',
                canStop: true,
            };
        case 'mic_error':
        case 'error': {
            const failure = resolveFailureProjection(snapshot);
            return {
                compatStatus: failure.compatStatus,
                sessionStatus: failure.sessionStatus,
                sessionMode: 'idle',
                canStop: failure.canStop,
            };
        }
        case 'disconnected':
        default: {
            const disconnected = resolveDisconnectedProjection(snapshot);
            return {
                compatStatus: disconnected.compatStatus,
                sessionStatus: disconnected.sessionStatus,
                sessionMode: 'idle',
                canStop: disconnected.canStop,
            };
        }
    }
}

/**
 * Project the runtime machine snapshot into a session snapshot for `adapterId`.
 *
 * The machine is a single global slot; only one adapter owns it at a time
 * (`snapshot.adapterId`). When the machine is owned by a different adapter, this
 * adapter must report `disconnected` so a non-owning adapter never mirrors
 * another adapter's live state. A `null` owner means a local engine adapter owns
 * the machine (local_direct/local_conversation share one engine), so any local
 * adapter projects it.
 */
function machineOwnedByAdapter(
    adapterId: VoiceAdapterId,
    engineKind: VoiceAdapterEngineKind,
    snapshot: VoiceConversationRuntimeSnapshot,
): boolean {
    return snapshot.adapterId === adapterId
        || (snapshot.adapterId === null && engineKind === 'local');
}

function createDisconnectedSessionSnapshot(adapterId: VoiceAdapterId): VoiceSessionSnapshot {
    return {
        adapterId,
        sessionId: null,
        status: 'disconnected',
        mode: 'idle',
        canStop: false,
    };
}

export function deriveLocalVoiceSessionSnapshot(
    adapterId: VoiceAdapterId,
    engineKind: VoiceAdapterEngineKind,
    snapshot: VoiceConversationRuntimeSnapshot,
): VoiceSessionSnapshot {
    if (!machineOwnedByAdapter(adapterId, engineKind, snapshot)) {
        return createDisconnectedSessionSnapshot(adapterId);
    }

    const projection = deriveLocalVoiceRuntimeProjection(snapshot);

    return {
        adapterId,
        sessionId: snapshot.controlSessionId,
        status: projection.sessionStatus,
        mode: projection.sessionMode,
        canStop: projection.canStop,
        ...(snapshot.micMuted ? { micMuted: true } : {}),
        ...(snapshot.error
            ? {
                errorCode: snapshot.error.kind,
                errorMessage: snapshot.error.reason,
                errorRecoveryAction: snapshot.error.recoveryAction,
                errorPresentation: snapshot.error.presentation,
            }
            : {}),
        ...(snapshot.reconnecting
            ? { presentationState: 'reconnecting' as const }
            : snapshot.state === 'interrupted'
                ? { presentationState: 'interrupted' as const }
                : {}),
    };
}
