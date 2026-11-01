import { t, type TranslationKeyNoParams } from '@/text';

/**
 * Canonical code -> message mapping for local voice errors (`LocalVoiceState.error`).
 * Producers (STT input, TTS output, turn dispatch) only write a snake_case code, plus optional raw
 * detail in `errorMessage`; this module owns the user-facing, localized text.
 */
const LOCAL_VOICE_ERROR_KEYS: Readonly<Record<string, TranslationKeyNoParams>> = {
  send_failed: 'voiceSurface.errors.sendFailed',
  stt_failed: 'voiceSurface.errors.sttFailed',
  stt_timeout: 'voiceSurface.errors.sttTimeout',
  stt_auth_failed: 'voiceSurface.errors.sttAuthFailed',
  stt_rate_limited: 'voiceSurface.errors.sttRateLimited',
  missing_stt_base_url: 'voiceSurface.errors.missingSttBaseUrl',
  missing_stt_api_key: 'voiceSurface.errors.missingSttApiKey',
  recording_start_failed: 'voiceSurface.errors.recordingStartFailed',
  recording_stop_failed: 'voiceSurface.errors.recordingStopFailed',
  device_stt_unavailable: 'voiceSurface.errors.deviceSttUnavailable',
  device_stt_permission_denied: 'voiceSurface.errors.speechPermissionDenied',
  device_stt_start_failed: 'voiceSurface.errors.deviceSttStartFailed',
  local_neural_stt_unavailable: 'voiceSurface.errors.localNeuralSttUnavailable',
  local_neural_pack_missing: 'voiceSurface.errors.localNeuralPackNotInstalled',
  local_neural_pack_not_installed: 'voiceSurface.errors.localNeuralPackNotInstalled',
  local_neural_stt_start_failed: 'voiceSurface.errors.localNeuralSttStartFailed',
  local_neural_audio_capture_failed: 'voiceSurface.errors.localNeuralAudioCaptureFailed',
  tts_failed: 'voiceSurface.errors.ttsFailed',
  voice_agent_unavailable: 'voiceSurface.errors.voiceAgentUnavailable',
};

/** Feature toggles (Settings → Features) the daemon voice agent depends on, by error code. */
const VOICE_AGENT_FEATURE_LABEL_KEYS: Readonly<Record<string, TranslationKeyNoParams>> = {
  voice_agent_feature_disabled: 'settingsFeatures.expVoiceAgent',
  voice_agent_requires_subagents: 'settingsFeatures.expExecutionRuns',
  voice_agent_requires_voice: 'settingsFeatures.voice',
};

/** Codes whose localized text is generic, so the raw root cause is worth showing next to it. */
const CODES_WITH_DETAIL = new Set(['send_failed', 'stt_failed', 'tts_failed']);

export type LocalVoiceErrorPresentation = Readonly<{ message: string; detail: string | null }>;

export function formatLocalVoiceErrorMessage(
  params: Readonly<{ errorCode: string; errorMessage?: string | null }>,
): LocalVoiceErrorPresentation {
  const code = params.errorCode.trim();
  const rawDetail = typeof params.errorMessage === 'string' ? params.errorMessage.trim() : '';
  const detail = rawDetail && rawDetail !== code ? rawDetail : null;

  const featureLabelKey = VOICE_AGENT_FEATURE_LABEL_KEYS[code];
  if (featureLabelKey) {
    return { message: t('voiceSurface.errors.voiceAgentRequiresFeature', { feature: t(featureLabelKey) }), detail: null };
  }

  const key = LOCAL_VOICE_ERROR_KEYS[code];
  if (!key) {
    return { message: t('voiceSurface.errors.generic'), detail: detail ?? code };
  }
  return { message: t(key), detail: CODES_WITH_DETAIL.has(code) ? detail : null };
}
