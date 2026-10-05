import { describe, expect, it } from 'vitest';

import { ELEVENLABS_SETTINGS_SECTION } from '../../voiceSettingsPresentation.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('ElevenLabs settings descriptor', () => {
  it('provides presentation data for every generic renderer field', () => {
    const descriptor = ELEVENLABS_SETTINGS_SECTION;
    expect(descriptor).toMatchObject({
      kind: 'voice.provider-settings.v1',
      modes: ['happier', 'byo'],
      titleKey: 'settingsVoice.byo.title',
      footerKey: 'settingsVoice.realtimeProviders.elevenLabs.accountFooter',
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
      expect.objectContaining({ kind: 'range', path: 'tts.voiceSettings.stability', min: 0, max: 1, step: 0.01, nullable: true, defaultValue: 0.5 }),
      expect.objectContaining({ kind: 'range', path: 'tts.voiceSettings.similarityBoost', min: 0, max: 1, step: 0.01, nullable: true, defaultValue: 0.75 }),
      expect.objectContaining({ kind: 'range', path: 'tts.voiceSettings.speed', min: 0.7, max: 1.2, step: 0.1, nullable: true, defaultValue: 1, valueSuffix: '×', fractionDigits: 1 }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings?.presentation?.groups).toEqual(descriptor.groups);
    expect(descriptor.groups.flatMap((group) => group.fieldPaths).sort()).toEqual(descriptor.fields.map((field) => field.path).sort());
    expect(descriptor.groups.filter((group) => 'includeCredentials' in group && group.includeCredentials)).toHaveLength(1);
  });
});
