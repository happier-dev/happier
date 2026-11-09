import { z } from 'zod/mini';
import { VoiceDictationLanguageSchema } from '../recognitionLanguage.js';
import { getDefaultModelPackId } from '../modelPacks/catalog.js';

import {
  VoiceLocalSttSchema,
} from './localStt.js';

const VoiceDictationSttSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const stt = raw as Record<string, unknown>;
  const neural = stt.localNeural;
  // A previously selected recognizer with no model used June. Preserve that
  // installation instead of silently requesting the larger batch model.
  if (stt.provider !== 'local_neural' || !neural || typeof neural !== 'object' || Array.isArray(neural)) return raw;
  const localNeural = neural as Record<string, unknown>;
  return localNeural.assetId === null
    ? { ...stt, localNeural: { ...localNeural, assetId: getDefaultModelPackId('stt_sherpa') } }
    : raw;
}), VoiceLocalSttSchema);

export const VoiceDictationSettingsSchema = z.object({
  sttBinding: z._default(z.enum(['explicit', 'same_as_local']), 'explicit'),
  language: z._default(VoiceDictationLanguageSchema, null),
  stt: z.prefault(VoiceDictationSttSchema, { provider: 'device', localNeural: { assetId: null } }),
});

export type VoiceDictationSettings = z.infer<typeof VoiceDictationSettingsSchema>;

export const voiceDictationSettingsDefaults: VoiceDictationSettings =
  VoiceDictationSettingsSchema.parse({});

export function voiceDictationSettingsParse(input: unknown): VoiceDictationSettings {
  const defaults = VoiceDictationSettingsSchema.parse({});
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;

  const raw = input as Record<string, unknown>;
  const sttBinding = VoiceDictationSettingsSchema.shape.sttBinding.safeParse(raw.sttBinding);
  const language = VoiceDictationLanguageSchema.safeParse(raw.language);
  const stt = VoiceDictationSettingsSchema.shape.stt.safeParse(raw.stt);

  return {
    sttBinding: sttBinding.success ? sttBinding.data : defaults.sttBinding,
    language: language.success ? language.data : defaults.language,
    stt: stt.success ? stt.data : defaults.stt,
  };
}
