import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';

export const VOICE_MACHINE_ERROR_TRANSLATION_KEYS = {
    mic_permission_denied: 'settingsVoice.local.machineErrors.mic_permission_denied',
    mic_unavailable: 'settingsVoice.local.machineErrors.mic_unavailable',
    speech_recognition_unavailable: 'settingsVoice.local.machineErrors.speech_recognition_unavailable',
    mic_ended: 'settingsVoice.local.machineErrors.mic_ended',
    mic_plateau: 'settingsVoice.local.machineErrors.mic_plateau',
    transport_disconnect: 'settingsVoice.local.machineErrors.transport_disconnect',
    provider_error: 'settingsVoice.local.machineErrors.provider_error',
    provider_auth_invalid: 'settingsVoice.local.machineErrors.provider_auth_invalid',
    provider_setup_required: 'voice.readiness.settings_missing_required_setting',
    execution_machine_unavailable: 'voice.readiness.execution_machine_missing',
    audio_context_suspended: 'settingsVoice.local.machineErrors.audio_context_suspended',
    stt_timeout: 'settingsVoice.local.machineErrors.stt_timeout',
    tts_failed: 'settingsVoice.local.machineErrors.tts_failed',
    turn_aborted: 'settingsVoice.local.machineErrors.turn_aborted',
    authentication_required: 'settingsVoice.local.machineErrors.authentication_required',
    session_unavailable: 'settingsVoice.local.machineErrors.session_unavailable',
    unsupported_runtime: 'settingsVoice.local.machineErrors.unsupported_runtime',
    update_required: 'settingsVoice.local.machineErrors.update_required',
    feature_unavailable: 'settingsVoice.local.machineErrors.feature_unavailable',
    service_temporarily_unavailable: 'errors.voiceServiceUnavailable',
} as const;

/**
 * A machine error kind is a family; some of its safe reasons carry their own sentence because the
 * next step differs from the family's generic copy. Any other reason keeps the kind's copy, so a
 * raw reason code or transport text is never shown.
 */
export const VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS = {
    voice_previous_session_stop_failed: 'settingsVoice.local.machineErrors.previous_session_stop_failed',
    voice_agent_selection_unavailable: 'settingsVoice.local.machineErrors.agent_selection_unavailable',
} as const;

export type VoiceMachineErrorTranslationKey =
    | (typeof VOICE_MACHINE_ERROR_TRANSLATION_KEYS)[keyof typeof VOICE_MACHINE_ERROR_TRANSLATION_KEYS]
    | (typeof VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS)[keyof typeof VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS];

function isVoiceMachineErrorReasonWithCopy(
    reason: string | undefined,
): reason is keyof typeof VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS {
    return reason !== undefined
        && Object.prototype.hasOwnProperty.call(VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS, reason);
}

export function resolveVoiceMachineErrorTranslationKey(
    kind: VoiceMachineErrorKind,
    reason?: string,
): VoiceMachineErrorTranslationKey {
    // Capture retains the public error code; Send retains the safe message.
    const copyReason = reason?.toLowerCase();
    if ((kind === 'service_temporarily_unavailable' || kind === 'provider_setup_required') && isVoiceMachineErrorReasonWithCopy(copyReason)) {
        return VOICE_MACHINE_ERROR_REASON_TRANSLATION_KEYS[copyReason];
    }
    switch (kind) {
        case 'mic_permission_revoked':
            return VOICE_MACHINE_ERROR_TRANSLATION_KEYS.mic_permission_denied;
        case 'reconnect_exhausted':
            return VOICE_MACHINE_ERROR_TRANSLATION_KEYS.transport_disconnect;
        default:
            return VOICE_MACHINE_ERROR_TRANSLATION_KEYS[kind];
    }
}
