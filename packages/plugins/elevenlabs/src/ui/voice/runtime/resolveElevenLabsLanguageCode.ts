const SUPPORTED_LANGUAGE_CODES = new Set([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'pt-br', 'ro',
  'ru', 'sk', 'sv', 'ta', 'tr', 'uk', 'vi', 'zh',
]);

/** Provider-owned projection from the app's locale preference to ElevenLabs' language vocabulary. */
export function resolveElevenLabsLanguageCode(preference: string | null): string | null {
  const normalized = typeof preference === 'string' ? preference.trim().toLowerCase() : '';
  if (!normalized) return null;
  if (normalized === 'pt-br') return normalized;
  const base = normalized.split(/[-_]/u, 1)[0] ?? '';
  return SUPPORTED_LANGUAGE_CODES.has(base) ? base : null;
}
