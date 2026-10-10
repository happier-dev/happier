import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** Existing Dictation preference: null means the selected engine's default. */
export const VoiceDictationLanguageSchema = lazyZodSchema(() => z.preprocess(
  (value) => typeof value === 'string' ? value.trim() || null : value,
  z.string().max(64).nullable(),
));

export function normalizeVoiceDictationLanguage(value: unknown): string | null {
  const parsed = VoiceDictationLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
