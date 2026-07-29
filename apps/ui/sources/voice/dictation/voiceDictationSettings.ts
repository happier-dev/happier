import { z } from 'zod';

import {
  VoiceLocalSttSchema,
  type VoiceLocalSttSettings,
} from '@/sync/domains/settings/voiceLocalSttSettings';

const VoiceDictationLanguageSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() || null : value,
  z.string().max(64).nullable(),
);

function stripInlineSttSecrets(stt: VoiceLocalSttSettings): VoiceLocalSttSettings {
  return {
    ...stt,
    openaiCompat: {
      ...stt.openaiCompat,
      // Dictation persists only non-secret provider configuration. Credentials
      // remain owned by the canonical machine/account credential stores.
      apiKey: null,
    },
  };
}

export const VoiceDictationSettingsSchema = z.object({
  sttBinding: z.enum(['explicit', 'same_as_local']).default('explicit'),
  language: VoiceDictationLanguageSchema.default(null),
  stt: VoiceLocalSttSchema.prefault({ provider: 'device' }),
}).transform((settings) => ({
  ...settings,
  stt: stripInlineSttSecrets(settings.stt),
}));

export type VoiceDictationSettings = z.infer<typeof VoiceDictationSettingsSchema>;

export const voiceDictationSettingsDefaults: VoiceDictationSettings =
  VoiceDictationSettingsSchema.parse({});

export function voiceDictationSettingsParse(input: unknown): VoiceDictationSettings {
  const parsed = VoiceDictationSettingsSchema.safeParse(input);
  return parsed.success ? parsed.data : VoiceDictationSettingsSchema.parse({});
}
