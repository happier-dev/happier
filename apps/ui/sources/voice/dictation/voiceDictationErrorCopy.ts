import type { VoiceDictationFailureReason } from './VoiceDictationController';

const FAILURE_TRANSLATION_KEYS = {
    capture_failed: 'voiceAssistant.dictationErrors.captureFailed',
    provider_unavailable: 'voiceAssistant.dictationErrors.providerUnavailable',
    transcription_credentials_required: 'voiceAssistant.dictationErrors.transcriptionCredentialsRequired',
    transcription_machine_unavailable: 'voiceAssistant.dictationErrors.transcriptionMachineUnavailable',
    transcription_model_not_installed: 'voice.readiness.model_missing',
    transcription_transfer_failed: 'voiceAssistant.dictationErrors.transcriptionTransferFailed',
    transcription_failed: 'voiceAssistant.dictationErrors.transcriptionFailed',
    recorded_audio_size_unavailable: 'voiceAssistant.dictationErrors.recordedAudioSizeUnavailable',
    recorded_audio_limit_exceeded: 'voiceAssistant.dictationErrors.recordedAudioLimitExceeded',
} as const satisfies Readonly<Record<VoiceDictationFailureReason, string>>;

export type VoiceDictationErrorTranslationKey =
    (typeof FAILURE_TRANSLATION_KEYS)[VoiceDictationFailureReason]
    | 'voiceAssistant.dictationErrors.microphoneOwnedByVoice'
    | 'voiceAssistant.dictationErrors.microphoneOwnedByDictation';

/** Failures whose fix is in Dictation's setup (its copy says to review it): their recovery offers Set up. */
const SETUP_FAILURES: ReadonlySet<VoiceDictationFailureReason> = new Set<VoiceDictationFailureReason>([
    'provider_unavailable',
    'transcription_credentials_required',
    'transcription_machine_unavailable',
    'transcription_model_not_installed',
    'transcription_failed',
]);

export function voiceDictationFailureNeedsSetup(reason: VoiceDictationFailureReason): boolean {
    return SETUP_FAILURES.has(reason);
}

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
