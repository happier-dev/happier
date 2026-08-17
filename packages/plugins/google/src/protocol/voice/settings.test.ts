import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS,
  GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS,
  GoogleCloudTtsSettingsSchema,
  GoogleGeminiSttSettingsSchema,
} from './settings.js';

describe('Google Voice settings', () => {
  it('uses the same canonical defaults and constraints as the split manifest declarations', () => {
    const [stt, tts] = PLUGIN_MANIFEST.contributes.voiceProviders;

    expect(GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS).toEqual(
      Object.fromEntries(stt.settings.fields.map((field) => [field.id, field.default])),
    );
    expect(GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS).toEqual(
      Object.fromEntries(tts.settings.fields.map((field) => [field.id, field.default])),
    );
    expect(GoogleGeminiSttSettingsSchema.safeParse(GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS).success).toBe(true);
    expect(GoogleCloudTtsSettingsSchema.safeParse(GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS).success).toBe(true);
  });
});
