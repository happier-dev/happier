import { describe, expect, it } from 'vitest';

import type { VoiceMachineErrorKind } from './voiceConversationRuntimeTypes';
import { resolveVoiceMachineErrorTranslationKey } from './voiceMachineErrorCopy';

const expectedTranslationKeys = {
    mic_permission_denied: 'settingsVoice.local.machineErrors.mic_permission_denied',
    mic_permission_revoked: 'settingsVoice.local.machineErrors.mic_permission_denied',
    mic_ended: 'settingsVoice.local.machineErrors.mic_ended',
    mic_plateau: 'settingsVoice.local.machineErrors.mic_plateau',
    transport_disconnect: 'settingsVoice.local.machineErrors.transport_disconnect',
    provider_error: 'settingsVoice.local.machineErrors.provider_error',
    provider_auth_invalid: 'settingsVoice.local.machineErrors.provider_auth_invalid',
    provider_setup_required: 'voice.readiness.settings_missing_required_setting',
    execution_machine_unavailable: 'voice.readiness.execution_machine_missing',
    reconnect_exhausted: 'settingsVoice.local.machineErrors.transport_disconnect',
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
    mic_unavailable: 'settingsVoice.local.machineErrors.mic_unavailable',
    speech_recognition_unavailable: 'settingsVoice.local.machineErrors.speech_recognition_unavailable',
} as const satisfies Readonly<Record<VoiceMachineErrorKind, string>>;

describe('voiceMachineErrorCopy', () => {
    it.each(['voice_agent_selection_unavailable', 'VOICE_AGENT_SELECTION_UNAVAILABLE'])(
        'explains the unavailable Session Agent with the existing setup recovery (%s)', reason => {
        expect(resolveVoiceMachineErrorTranslationKey('provider_setup_required', reason))
            .toBe('settingsVoice.local.machineErrors.agent_selection_unavailable');
    });
    it('maps every machine error kind onto one canonical translation key', () => {
        for (const [kind, key] of Object.entries(expectedTranslationKeys)) {
            expect(resolveVoiceMachineErrorTranslationKey(kind as VoiceMachineErrorKind)).toBe(key);
        }
    });

    it('gives the previous-session Stop failure its own sentence and keeps other reasons on the kind copy', () => {
        expect(resolveVoiceMachineErrorTranslationKey(
            'service_temporarily_unavailable',
            'voice_previous_session_stop_failed',
        )).toBe('settingsVoice.local.machineErrors.previous_session_stop_failed');
        expect(resolveVoiceMachineErrorTranslationKey(
            'service_temporarily_unavailable',
            'socket hang up',
        )).toBe('errors.voiceServiceUnavailable');
        expect(resolveVoiceMachineErrorTranslationKey('provider_error', 'voice_previous_session_stop_failed'))
            .toBe('settingsVoice.local.machineErrors.provider_error');
    });
});
