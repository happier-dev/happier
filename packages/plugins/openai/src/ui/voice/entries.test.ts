import { describe, expect, it } from 'vitest';

import { VOICE_PROVIDER_PRESENTATIONS } from './entries.js';

describe('OpenAI bundled Voice presentation', () => {
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
