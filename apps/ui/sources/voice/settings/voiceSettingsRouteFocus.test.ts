import { describe, expect, it } from 'vitest';

import {
  VOICE_SETTINGS_PRIVACY_FOCUS_TARGET,
  VOICE_SETTINGS_PROVIDER_FOCUS_TARGET,
  resolveVoiceSettingsRecoveryFocus,
  resolveVoiceSettingsRouteFocus,
} from './voiceSettingsRouteFocus';

describe('voice settings route focus', () => {
  it('keeps provider disclosure and context-sharing focus as separate destinations', () => {
    expect(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET).toMatchObject({
      pathname: '/settings/voice/conversations',
      params: { focus: 'provider' },
    });
    expect(VOICE_SETTINGS_PRIVACY_FOCUS_TARGET).toMatchObject({
      params: { focus: 'privacy' },
    });
    expect(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET).not.toEqual(
      VOICE_SETTINGS_PRIVACY_FOCUS_TARGET,
    );
  });

  it('accepts canonical Voice section focus and fails closed for other values', () => {
    expect(resolveVoiceSettingsRouteFocus('provider')).toBe('provider');
    expect(resolveVoiceSettingsRouteFocus(['privacy', 'provider'])).toBe('privacy');
    expect(resolveVoiceSettingsRouteFocus('execution_machine')).toBe('execution_machine');
    expect(resolveVoiceSettingsRouteFocus('local')).toBe('local');
    expect(resolveVoiceSettingsRouteFocus('disclosure')).toBeNull();
    expect(resolveVoiceSettingsRouteFocus(undefined)).toBeNull();
  });

  it('maps readiness recovery through the existing settings section focus owner', () => {
    expect(resolveVoiceSettingsRecoveryFocus('select_execution_machine')).toBe('execution_machine');
    expect(resolveVoiceSettingsRecoveryFocus('install_model')).toBe('local');
    expect(resolveVoiceSettingsRecoveryFocus('configure_credential')).toBe('provider');
    expect(resolveVoiceSettingsRecoveryFocus('switch_provider')).toBe('provider');
    expect(resolveVoiceSettingsRecoveryFocus('none')).toBeNull();
  });
});
