import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Existing Dictation preference: null means the selected engine's default. */
export const VoiceDictationLanguageSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => typeof value === 'string' ? value.trim() || null : value), z.nullable(z.string().check(z.maxLength(64)))));

export function normalizeVoiceDictationLanguage(value: unknown): string | null {
  const parsed = VoiceDictationLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
