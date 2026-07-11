import { describe, expect, it } from 'vitest';

import { createElevenLabsSettingsSection } from './settings.js';

describe('ElevenLabs settings descriptor', () => {
  it('provides presentation data for every generic renderer field', () => {
    const descriptor = createElevenLabsSettingsSection();
    expect(descriptor).toMatchObject({
      titleKey: 'settingsVoice.byo.title',
      footerKey: 'settingsVoice.byo.provisioningGroupFooter',
      credential: {
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
    expect(descriptor.fields.find((field) => field.kind === 'autoprovision')).toMatchObject({
      path: 'byo.agentId',
      ttsPath: 'tts',
    });
  });
});
