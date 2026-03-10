import { t, type TranslationKey } from '@/text';

const TRANSLATION_KEY_PATTERN = /^[a-z]+(?:\.[A-Za-z0-9_-]+)+$/;

export function translatePromptLibraryMessage(message: string): string {
  const normalized = String(message ?? '').trim();
  if (!normalized) return '';
  if (!TRANSLATION_KEY_PATTERN.test(normalized)) return normalized;
  return t(normalized as TranslationKey);
}
