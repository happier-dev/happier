import { describe, expect, it } from 'vitest';

import { ELEVENLABS_SETTINGS_SECTION } from '../../voiceSettingsPresentation.js';

describe('ElevenLabs settings descriptor', () => {
  it('provides presentation data for every generic renderer field', () => {
    const descriptor = ELEVENLABS_SETTINGS_SECTION;
    expect(descriptor).toMatchObject({
      kind: 'voice.provider-settings.v1',
      modes: ['happier', 'byo'],
      titleKey: 'settingsVoice.byo.title',
      footerKey: 'settingsVoice.byo.provisioningGroupFooter',
      credential: {
        credentialPurpose: 'voice.client-auth.elevenlabs',
        titleKey: 'settingsVoice.byo.apiKeyTitle',
        promptTitleKey: 'settingsVoice.byo.apiKeyTitle',
        promptBodyKey: 'settingsVoice.byo.apiKeyDescription',
      },
    });
    for (const field of descriptor.fields) {
      expect(field).toEqual(expect.objectContaining({
        titleKey: expect.any(String),
        subtitleKey: expect.any(String),
      }));
    }
    expect(descriptor.fields).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'autoprovision' }),
    ]));
    expect(descriptor.fields.filter((field) => field.path.startsWith('tts.voiceSettings.'))).toEqual([
      expect.objectContaining({ path: 'tts.voiceSettings.stability', min: 0, max: 1 }),
      expect.objectContaining({ path: 'tts.voiceSettings.similarityBoost', min: 0, max: 1 }),
      expect.objectContaining({ path: 'tts.voiceSettings.speed', min: 0.7, max: 1.2 }),
    ]);
  });
});
