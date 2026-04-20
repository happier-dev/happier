import type { VoiceAdapterId, VoiceSessionMode, VoiceSessionSnapshot, VoiceSessionStatus } from '@/voice/session/types';
import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';

export type LocalVoiceCompatStatus = 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

type DerivedLocalVoiceRuntimeProjection = Readonly<{
    compatStatus: LocalVoiceCompatStatus;
    sessionStatus: VoiceSessionStatus;
    sessionMode: VoiceSessionMode;
    canStop: boolean;
}>;

function resolveDisconnectedStatus(snapshot: VoiceConversationRuntimeSnapshot): VoiceSessionStatus {
    return snapshot.error ? 'error' : 'disconnected';
}

function resolveDisconnectedCanStop(snapshot: VoiceConversationRuntimeSnapshot): boolean {
    return snapshot.error !== null;
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
        case 'sending':
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
        case 'error':
            return {
                compatStatus: 'error',
                sessionStatus: 'error',
                sessionMode: 'idle',
                canStop: true,
            };
        case 'disconnected':
        default:
            return {
                compatStatus: 'idle',
                sessionStatus: resolveDisconnectedStatus(snapshot),
                sessionMode: 'idle',
                canStop: resolveDisconnectedCanStop(snapshot),
            };
    }
}

export function deriveLocalVoiceSessionSnapshot(
    adapterId: VoiceAdapterId,
    snapshot: VoiceConversationRuntimeSnapshot,
): VoiceSessionSnapshot {
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
            }
            : {}),
    };
}
