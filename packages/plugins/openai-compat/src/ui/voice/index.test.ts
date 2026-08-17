import { describe, expect, it } from 'vitest';

import { VOICE_PROVIDER_PRESENTATIONS } from './index.js';

describe('OpenAI-compatible bundled voice UI contribution', () => {
  it('projects exactly the two manifest speech declarations without duplicating provider policy', () => {
    expect(VOICE_PROVIDER_PRESENTATIONS).toHaveLength(2);
    expect(VOICE_PROVIDER_PRESENTATIONS.map((entry) => entry.providerId)).toEqual([
      'happier.voice.openai-compat/stt',
      'happier.voice.openai-compat/tts',
    ]);

    for (const entry of VOICE_PROVIDER_PRESENTATIONS) {
      expect(entry).not.toHaveProperty('localId');
      expect(entry).not.toHaveProperty('declaration');
      expect(entry).not.toHaveProperty('roles');
      expect(entry).not.toHaveProperty('requirements');
      expect(entry).not.toHaveProperty('activate');
    }
  });

  it('keeps only presentation metadata behind the internal first-party boundary', () => {
    const [stt, tts] = VOICE_PROVIDER_PRESENTATIONS;
    const sttSettings = stt?.createSettingsSpec();
    const ttsSettings = tts?.createSettingsSpec();

    expect(stt?.createSettingsSpec).not.toBe(tts?.createSettingsSpec);
    expect(sttSettings?.fields?.map((field) => field.fieldId)).toEqual([
      'baseUrl',
      'model',
      'language',
    ]);
    expect(ttsSettings?.fields?.map((field) => field.fieldId)).toEqual([
      'baseUrl',
      'model',
      'voiceName',
      'format',
    ]);
    expect(sttSettings?.credential).toEqual({
      titleKey: 'settingsVoice.local.sttApiKey',
      promptTitleKey: 'settingsVoice.local.sttApiKeyTitle',
      promptBodyKey: 'settingsVoice.local.sttApiKeyDescription',
    });
    expect(ttsSettings?.test).toEqual({
      missingValueMessageKey: 'settingsVoice.local.testTtsMissingBaseUrl',
    });
    expect(sttSettings).not.toHaveProperty('runtime');
    expect(sttSettings).not.toHaveProperty('defaultConfig');
    expect(sttSettings).not.toHaveProperty('parseConfig');
    expect(sttSettings).not.toHaveProperty('migrateLegacy');
    expect(sttSettings?.credential).not.toHaveProperty('slotId');
    expect(sttSettings?.credential).not.toHaveProperty('purpose');
  });
});
