import { describe, expect, it } from 'vitest';
import { createVoiceSettingsOwner } from './voiceSettings.js';

describe('shared Voice settings owner', () => {
  const owner = createVoiceSettingsOwner({ bundledContributions: [] });

  it('preserves forward provider envelopes and unknown roots while recovering malformed known preferences', () => {
    const future = { schemaVersion: 2, config: { futureMode: true } };
    const settings = owner.voiceSettingsParse({
      privacy: { shareFilePaths: 'invalid' },
      providers: { 'example.voice.future/conversation': future },
      futurePreference: { enabled: true },
    });
    expect(settings.privacy.shareFilePaths).toBe(false);
    expect(settings.providers['example.voice.future/conversation']).toEqual(future);
    expect(Reflect.get(settings, 'futurePreference')).toEqual({ enabled: true });
  });

  it('uses the same local conversation schema and writer without changing other Voice owners', () => {
    const settings = owner.voiceSettingsParse({ assistantLanguage: 'fr', welcome: { enabled: false } });
    const conversation = owner.readLocalConversationVoiceSettings(settings);
    const written = owner.writeLocalConversationVoiceSettings(settings, {
      ...conversation, handsFree: { ...conversation.handsFree, enabled: true },
    });
    expect(owner.readLocalConversationVoiceSettings(written).handsFree.enabled).toBe(true);
    expect(written.welcome).toEqual(settings.welcome);
    expect(written.assistantLanguage).toBe('fr');
    expect(owner.readLocalDirectVoiceSettings(written)).toEqual(owner.readLocalDirectVoiceSettings(settings));
  });
});
