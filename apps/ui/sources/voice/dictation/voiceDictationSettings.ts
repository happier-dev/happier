import { z } from 'zod';

import {
  VoiceLocalSttSchema,
} from '@/sync/domains/settings/voiceLocalSttSettings';

const VoiceDictationLanguageSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.trim() || null : value,
  z.string().max(64).nullable(),
);

export const VoiceDictationSettingsSchema = z.object({
  sttBinding: z.enum(['explicit', 'same_as_local']).default('explicit'),
  language: VoiceDictationLanguageSchema.default(null),
  stt: VoiceLocalSttSchema.prefault({ provider: 'device' }),
});

export type VoiceDictationSettings = z.infer<typeof VoiceDictationSettingsSchema>;

export const voiceDictationSettingsDefaults: VoiceDictationSettings =
  VoiceDictationSettingsSchema.parse({});

export function voiceDictationSettingsParse(input: unknown): VoiceDictationSettings {
  const parsed = VoiceDictationSettingsSchema.safeParse(input);
  return parsed.success ? parsed.data : VoiceDictationSettingsSchema.parse({});
}
