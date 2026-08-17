import type { VoiceDictationFailureReason } from './VoiceDictationController';

const FAILURE_TRANSLATION_KEYS = {
    capture_failed: 'voiceAssistant.dictationErrors.captureFailed',
    provider_unavailable: 'voiceAssistant.dictationErrors.providerUnavailable',
    capture_start_deadline_exceeded: 'voiceAssistant.dictationErrors.captureStartDeadlineExceeded',
    capture_duration_exceeded: 'voiceAssistant.dictationErrors.captureDurationExceeded',
    transcription_deadline_exceeded: 'voiceAssistant.dictationErrors.transcriptionDeadlineExceeded',
    transcript_character_limit_exceeded: 'voiceAssistant.dictationErrors.transcriptLimitExceeded',
    transcript_utf8_limit_exceeded: 'voiceAssistant.dictationErrors.transcriptLimitExceeded',
    recorded_audio_size_unavailable: 'voiceAssistant.dictationErrors.recordedAudioSizeUnavailable',
    recorded_audio_limit_exceeded: 'voiceAssistant.dictationErrors.recordedAudioLimitExceeded',
} as const satisfies Readonly<Record<VoiceDictationFailureReason, string>>;

export type VoiceDictationErrorTranslationKey =
    (typeof FAILURE_TRANSLATION_KEYS)[VoiceDictationFailureReason]
    | 'voiceAssistant.dictationErrors.microphoneOwnedByVoice'
    | 'voiceAssistant.dictationErrors.microphoneOwnedByDictation';

export function resolveVoiceDictationFailureTranslationKey(
    reason: VoiceDictationFailureReason,
): VoiceDictationErrorTranslationKey {
    return FAILURE_TRANSLATION_KEYS[reason];
}

export function resolveVoiceDictationStartErrorTranslationKey(
    error: unknown,
): VoiceDictationErrorTranslationKey | null {
    const code = error && typeof error === 'object' && 'code' in error
        ? (error as Readonly<{ code?: unknown }>).code
        : null;
    switch (code) {
        case 'voice_capture_busy_conversation':
            return 'voiceAssistant.dictationErrors.microphoneOwnedByVoice';
        case 'voice_capture_busy_dictation':
            return 'voiceAssistant.dictationErrors.microphoneOwnedByDictation';
        default:
            return null;
    }
}
