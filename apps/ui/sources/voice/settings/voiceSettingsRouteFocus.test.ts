import { describe, expect, it } from 'vitest';

import {
  VOICE_SETTINGS_PRIVACY_FOCUS_TARGET,
  VOICE_SETTINGS_PROVIDER_FOCUS_TARGET,
  resolveVoiceSettingsRouteFocus,
} from './voiceSettingsRouteFocus';

describe('voice settings route focus', () => {
  it('keeps provider disclosure and context-sharing focus as separate destinations', () => {
    expect(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET).toMatchObject({
      params: { focus: 'provider' },
    });
    expect(VOICE_SETTINGS_PRIVACY_FOCUS_TARGET).toMatchObject({
      params: { focus: 'privacy' },
    });
    expect(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET).not.toEqual(
      VOICE_SETTINGS_PRIVACY_FOCUS_TARGET,
    );
  });

  it('accepts provider or privacy focus and fails closed for other values', () => {
    expect(resolveVoiceSettingsRouteFocus('provider')).toBe('provider');
    expect(resolveVoiceSettingsRouteFocus(['privacy', 'provider'])).toBe('privacy');
    expect(resolveVoiceSettingsRouteFocus('disclosure')).toBeNull();
    expect(resolveVoiceSettingsRouteFocus(undefined)).toBeNull();
  });
});
