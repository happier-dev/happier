import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { voiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from './voiceMachineError';

import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';

function resolveVoiceMachineErrorKind(reason: string, preferredKind?: VoiceMachineErrorKind): VoiceMachineErrorKind {
    if (preferredKind) {
        return preferredKind;
    }
    if (reason === 'turn_aborted') {
        return 'turn_aborted';
    }
    if (reason === 'tts_failed') {
        return 'tts_failed';
    }
    if (reason.includes('permission_denied')) {
        return 'mic_permission_denied';
    }
    return 'provider_error';
}

export function transitionVoiceRuntimeToIdle(params: Readonly<{
    controlSessionId?: string | null;
    reason?: string | null;
    kind?: VoiceMachineErrorKind;
}>): void {
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    const reason = normalizeNonEmptyString(params.reason);

    if (!controlSessionId) {
        voiceConversationRuntimeMachine.reset();
        return;
    }

    if (!reason) {
        // Settle to the idle, mic-off `connected` state (turn-based / push-to-talk
        // between turns); not `listening`, which would imply a hot mic.
        voiceConversationRuntimeMachine.transitionToConnected({
            controlSessionId,
        });
        return;
    }

    voiceConversationRuntimeMachine.transitionToDisconnected({
        controlSessionId,
        error: createVoiceMachineError({
            kind: resolveVoiceMachineErrorKind(reason, params.kind),
            reason,
        }),
    });
}

export function confirmVoiceCaptureStarted(controlSessionId: string): void {
    const normalizedControlSessionId = normalizeNonEmptyString(controlSessionId);
    if (!normalizedControlSessionId) {
        return;
    }

    voiceConversationRuntimeMachine.confirmListeningStarted({
        controlSessionId: normalizedControlSessionId,
    });
}

export function surfaceRecoverableVoiceCaptureError(params: Readonly<{
    controlSessionId: string;
    reason: string;
    kind?: VoiceMachineErrorKind;
}>): void {
    transitionVoiceRuntimeToIdle({
        controlSessionId: params.controlSessionId,
        reason: params.reason,
        kind: params.kind,
    });
}
