import { resolveVoiceProviderLanguagePreference } from '@happier-dev/plugin-sdk/voice';

export const ELEVENLABS_SUPPORTED_LANGUAGE_CODES = Object.freeze([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'pt-br', 'ro',
  'ru', 'sk', 'sv', 'ta', 'tr', 'uk', 'vi', 'zh',
]);

/** Provider-owned projection from the app's locale preference to ElevenLabs' language vocabulary. */
export function resolveElevenLabsLanguageCode(
  preference: string | null,
): string | null {
  return resolveVoiceProviderLanguagePreference(preference, ELEVENLABS_SUPPORTED_LANGUAGE_CODES);
}
