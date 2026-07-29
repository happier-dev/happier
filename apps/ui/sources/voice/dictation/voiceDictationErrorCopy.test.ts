import { describe, expect, it } from 'vitest';

import { VoiceCaptureBusyError } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

import type { VoiceDictationFailureReason } from './VoiceDictationController';
import {
    resolveVoiceDictationFailureTranslationKey,
    resolveVoiceDictationStartErrorTranslationKey,
} from './voiceDictationErrorCopy';

const EXPECTED_FAILURE_KEYS = {
    capture_failed: 'voiceAssistant.dictationErrors.captureFailed',
    capture_start_deadline_exceeded: 'voiceAssistant.dictationErrors.captureStartDeadlineExceeded',
    capture_duration_exceeded: 'voiceAssistant.dictationErrors.captureDurationExceeded',
    transcription_deadline_exceeded: 'voiceAssistant.dictationErrors.transcriptionDeadlineExceeded',
    transcript_character_limit_exceeded: 'voiceAssistant.dictationErrors.transcriptLimitExceeded',
    transcript_utf8_limit_exceeded: 'voiceAssistant.dictationErrors.transcriptLimitExceeded',
    recorded_audio_size_unavailable: 'voiceAssistant.dictationErrors.recordedAudioSizeUnavailable',
    recorded_audio_limit_exceeded: 'voiceAssistant.dictationErrors.recordedAudioLimitExceeded',
} as const satisfies Readonly<Record<VoiceDictationFailureReason, string>>;

describe('voiceDictationErrorCopy', () => {
    it('maps every stable Dictation failure reason to bounded recovery copy', () => {
        for (const [reason, key] of Object.entries(EXPECTED_FAILURE_KEYS)) {
            expect(resolveVoiceDictationFailureTranslationKey(
                reason as VoiceDictationFailureReason,
            )).toBe(key);
        }
    });

    it('maps typed microphone ownership without exposing unrelated raw errors', () => {
        expect(resolveVoiceDictationStartErrorTranslationKey(
            new VoiceCaptureBusyError('conversation'),
        )).toBe('voiceAssistant.dictationErrors.microphoneOwnedByVoice');
        expect(resolveVoiceDictationStartErrorTranslationKey(
            new VoiceCaptureBusyError('dictation'),
        )).toBe('voiceAssistant.dictationErrors.microphoneOwnedByDictation');
        expect(resolveVoiceDictationStartErrorTranslationKey(
            new Error('provider_secret_raw_error'),
        )).toBeNull();
    });
});
