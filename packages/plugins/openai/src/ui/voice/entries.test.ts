import { describe, expect, it } from 'vitest';

import { VOICE_PROVIDER_PRESENTATIONS } from './entries.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('OpenAI bundled Voice presentation', () => {
  it('publishes curated configuration through the public Voice settings declaration', () => {
    const settings = PLUGIN_MANIFEST.contributes.voiceProviders[0]?.settings;
    expect(settings?.presentation).toMatchObject({
      kind: 'voice.provider-settings.v1',
      fields: expect.arrayContaining([
        expect.objectContaining({ kind: 'model', path: 'model', movingAliasRequiresOptIn: true }),
        expect.objectContaining({ kind: 'voice_catalog', path: 'voice', valueShape: 'string' }),
        expect.objectContaining({ kind: 'instructions', path: 'instructions' }),
        expect.objectContaining({ kind: 'select', path: 'turnDetection' }),
        expect.objectContaining({ kind: 'select', path: 'inputTranscriptionModel' }),
      ]),
    });
  });
  it('keeps qualified presentation separate from manifest-owned semantics', () => {
    const entry = VOICE_PROVIDER_PRESENTATIONS[0];

    expect(entry).toMatchObject({
      providerId: 'happier.voice.openai/realtime-openai',
      settingsSectionId: 'voice.provider.realtime_openai',
    });
    expect(entry).not.toHaveProperty('declaration');
    expect(entry).not.toHaveProperty('roles');
    expect(entry).not.toHaveProperty('requirements');
    expect(entry).not.toHaveProperty('supportedPlatforms');
    expect(entry).not.toHaveProperty('projectSettings');
    expect(entry).not.toHaveProperty('internal');
    expect(entry).not.toHaveProperty('createSettingsSection');
  });
});
