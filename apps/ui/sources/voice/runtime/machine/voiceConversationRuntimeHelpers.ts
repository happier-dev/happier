import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { readConnectedServiceUxDiagnosticFromError } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';

import { voiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError, resolveVoiceMachineErrorKind } from './voiceMachineError';

import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';

export function transitionVoiceRuntimeToIdle(params: Readonly<{
    controlSessionId?: string | null;
    reason?: string | null;
    kind?: VoiceMachineErrorKind;
    cause?: unknown;
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

    const error = createVoiceMachineError({
        kind: resolveVoiceMachineErrorKind(reason, params.kind),
        reason,
        uxDiagnostic: readConnectedServiceUxDiagnosticFromError(params.cause) ?? undefined,
    });
    if (params.cause !== undefined) {
        Object.defineProperty(error, 'cause', { value: params.cause, enumerable: false });
    }
    voiceConversationRuntimeMachine.transitionToDisconnected({
        controlSessionId,
        error,
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
    cause?: unknown;
}>): void {
    transitionVoiceRuntimeToIdle({
        controlSessionId: params.controlSessionId,
        reason: params.reason,
        kind: params.kind,
        cause: params.cause ?? params,
    });
}
