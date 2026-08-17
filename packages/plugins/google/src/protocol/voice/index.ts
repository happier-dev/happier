export {
  GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS,
  GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS,
  GoogleCloudTtsSettingsLegacySchema,
  GoogleCloudTtsSettingsSchema,
  GoogleGeminiSttSettingsLegacySchema,
  GoogleGeminiSttSettingsSchema,
  type GoogleCloudTtsSettingsLegacy,
  type GoogleCloudTtsSettings,
  type GoogleGeminiSttSettingsLegacy,
  type GoogleGeminiSttSettings,
} from './settings.js';

export const GOOGLE_VOICE_CREDENTIAL_KIND = 'api_key' as const;

export function classifyGoogleCloudLegacyCredential(value: Readonly<{
  androidCertSha1?: string | null;
}>): 'importable' | 'needs_machine_credential' {
  return typeof value.androidCertSha1 === 'string' && value.androidCertSha1.trim().length > 0
    ? 'needs_machine_credential'
    : 'importable';
}
