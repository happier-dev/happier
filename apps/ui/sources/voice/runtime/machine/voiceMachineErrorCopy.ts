import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';

export const VOICE_MACHINE_ERROR_TRANSLATION_KEYS = {
    mic_permission_denied: 'settingsVoice.local.machineErrors.mic_permission_denied',
    mic_ended: 'settingsVoice.local.machineErrors.mic_ended',
    mic_plateau: 'settingsVoice.local.machineErrors.mic_plateau',
    transport_disconnect: 'settingsVoice.local.machineErrors.transport_disconnect',
    provider_error: 'settingsVoice.local.machineErrors.provider_error',
    audio_context_suspended: 'settingsVoice.local.machineErrors.audio_context_suspended',
    stt_timeout: 'settingsVoice.local.machineErrors.stt_timeout',
    tts_failed: 'settingsVoice.local.machineErrors.tts_failed',
    turn_aborted: 'settingsVoice.local.machineErrors.turn_aborted',
} as const satisfies Record<VoiceMachineErrorKind, `settingsVoice.local.machineErrors.${string}`>;

export type VoiceMachineErrorTranslationKey =
    (typeof VOICE_MACHINE_ERROR_TRANSLATION_KEYS)[VoiceMachineErrorKind];

export function resolveVoiceMachineErrorTranslationKey(
    kind: VoiceMachineErrorKind,
): VoiceMachineErrorTranslationKey {
    return VOICE_MACHINE_ERROR_TRANSLATION_KEYS[kind];
}
