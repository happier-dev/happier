import { describe, expect, it } from 'vitest';

import { VOICE_PROVIDER_PRESENTATIONS } from './index.js';

describe('Google bundled voice UI contribution', () => {
  it('projects the two manifest declarations without duplicating provider policy', () => {
    const stt = VOICE_PROVIDER_PRESENTATIONS.find((entry) => entry.providerId.endsWith('/gemini-stt'));
    const tts = VOICE_PROVIDER_PRESENTATIONS.find((entry) => entry.providerId.endsWith('/google-cloud-tts'));

    expect(stt?.providerId).toBe('happier.voice.google/gemini-stt');
    expect(tts?.providerId).toBe('happier.voice.google/google-cloud-tts');
    expect(stt).not.toHaveProperty('localId');
    expect(stt).not.toHaveProperty('declaration');
    expect(stt).not.toHaveProperty('roles');
    expect(stt).not.toHaveProperty('requirements');
  });

  it('keeps only presentation metadata behind the internal first-party boundary', () => {
    const stt = VOICE_PROVIDER_PRESENTATIONS.find((entry) => entry.providerId.endsWith('/gemini-stt'));
    const tts = VOICE_PROVIDER_PRESENTATIONS.find((entry) => entry.providerId.endsWith('/google-cloud-tts'));

    expect(typeof stt?.createSettingsSpec).toBe('function');
    expect(typeof tts?.createSettingsSpec).toBe('function');
    expect(stt?.createSettingsSpec).not.toBe(tts?.createSettingsSpec);
    expect(stt?.createSettingsSpec).toHaveLength(0);
    expect(tts?.createSettingsSpec).toHaveLength(0);

    const sttSettings = stt?.createSettingsSpec();
    const ttsSettings = tts?.createSettingsSpec();
    expect(stt).not.toHaveProperty('speechTarget');
    expect(stt).not.toHaveProperty('schemas');
    expect(sttSettings).not.toHaveProperty('privacyDisclosureKey');
    expect(ttsSettings).not.toHaveProperty('privacyDisclosureKey');
    expect(sttSettings?.fields?.map((field) => field.fieldId)).toEqual(['model', 'language']);
    expect(ttsSettings?.fields?.map((field) => field.fieldId)).toEqual([
      'languageCode',
      'voiceName',
      'format',
      'speakingRate',
      'pitch',
    ]);
    expect(sttSettings?.credential).not.toHaveProperty('slotId');
    expect(sttSettings?.credential).not.toHaveProperty('purpose');
    expect(sttSettings).not.toHaveProperty('runtime');
    expect(sttSettings).not.toHaveProperty('defaultConfig');
    expect(sttSettings).not.toHaveProperty('parseConfig');
    expect(sttSettings).not.toHaveProperty('migrateLegacy');
    expect(sttSettings?.credential).toEqual({
      titleKey: 'settingsVoice.local.googleGeminiStt.apiKey.title',
      promptTitleKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptTitle',
      promptBodyKey: 'settingsVoice.local.googleGeminiStt.apiKey.promptBody',
    });
    expect(ttsSettings?.test).toEqual({
      missingValueMessageKey: 'settingsVoice.local.googleCloudTts.alerts.missingVoice',
    });
  });
});
