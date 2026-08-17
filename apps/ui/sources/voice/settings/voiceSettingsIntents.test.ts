import { describe, expect, it } from 'vitest';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import {
  VOICE_SETTINGS_INTENTS,
  resolveLegacyVoiceSettingsIntent,
} from './voiceSettingsIntents';

describe('voiceSettingsIntents', () => {
  it('defines the four approved user-intent destinations in order', () => {
    expect(VOICE_SETTINGS_INTENTS).toEqual([
      expect.objectContaining({ id: 'dictation', route: SETTINGS_ROUTES.voiceDictation }),
      expect.objectContaining({ id: 'conversations', route: SETTINGS_ROUTES.voiceConversations }),
      expect.objectContaining({ id: 'privacy', route: SETTINGS_ROUTES.voicePrivacy }),
      expect.objectContaining({ id: 'advanced', route: SETTINGS_ROUTES.voiceAdvanced }),
    ]);
  });

  it('preserves the two supported legacy focus deep links without accepting malformed values', () => {
    expect(resolveLegacyVoiceSettingsIntent('provider')).toBe('conversations');
    expect(resolveLegacyVoiceSettingsIntent('privacy')).toBe('privacy');
    expect(resolveLegacyVoiceSettingsIntent('unknown')).toBeNull();
    expect(resolveLegacyVoiceSettingsIntent(['provider'])).toBeNull();
    expect(resolveLegacyVoiceSettingsIntent(undefined)).toBeNull();
  });
});
