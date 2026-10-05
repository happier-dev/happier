import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

describe('VoicePrivacySection', () => {
  it('names every privacy switch and updates the canonical privacy setting', async () => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const screen = await renderScreen(React.createElement(VoicePrivacySection, {
      voice: voiceSettingsDefaults,
      setVoice,
    }));

    const settings = VOICE_PRIVACY_SETTINGS.settings;
    const expectedLabels = [
      t(settings.shareSessionSummary.titleKey),
      t(settings.shareRecentMessages.titleKey),
      t(settings.shareToolNames.titleKey),
      t(settings.sharePermissionRequests.titleKey),
      t(settings.shareDeviceInventory.titleKey),
    ];
    const switches = screen.tree.root.findAllByType('Switch' as any);
    expect(switches.map((control) => control.props.accessibilityLabel)).toEqual(expectedLabels);

    switches[0]?.props.onValueChange(!voiceSettingsDefaults.privacy.shareSessionSummary);
    expect(setVoice).toHaveBeenCalledWith({
      ...voiceSettingsDefaults,
      privacy: {
        ...voiceSettingsDefaults.privacy,
        shareSessionSummary: !voiceSettingsDefaults.privacy.shareSessionSummary,
      },
    });
  });

  it.each(['off', 'on_demand', 'automatic'] as const)(
    'selects the independent current UI context disclosure mode %s',
    async (currentUiContextMode) => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const screen = await renderScreen(React.createElement(VoicePrivacySection, {
      voice: voiceSettingsDefaults,
      setVoice,
    }));

    // Three short, always-visible choices (segmented), each with its own stable selector.
    expect(screen.findByTestId('settings.voice.privacy.currentUiContextMode')).toBeTruthy();
    for (const mode of ['off', 'on_demand', 'automatic']) {
      expect(screen.findByTestId(`settings.voice.privacy.currentUiContextMode:${mode}`)).toBeTruthy();
    }

    screen.pressByTestId(`settings.voice.privacy.currentUiContextMode:${currentUiContextMode}`);
    expect(setVoice).toHaveBeenCalledWith({
      ...voiceSettingsDefaults,
      privacy: {
        ...voiceSettingsDefaults.privacy,
        currentUiContextMode,
      },
    });
    },
  );
  it('edits the recent messages count in place, within 0–50', async () => {
    const setVoice = vi.fn();
    const { act } = await import('react-test-renderer');
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const voice = {
      ...voiceSettingsDefaults,
      privacy: { ...voiceSettingsDefaults.privacy, shareRecentMessages: true, recentMessagesCount: 3 },
    };
    const screen = await renderScreen(React.createElement(VoicePrivacySection, { voice, setVoice }));

    const field = () => screen.findByTestId('settings.voice.privacy.recentMessagesCount.field');
    expect(field()?.props.value).toBe('3');
    await act(async () => {
      field()!.props.onChangeText('80');
    });
    await act(async () => {
      field()!.props.onBlur();
    });

    expect(setVoice).toHaveBeenLastCalledWith({
      ...voice,
      privacy: { ...voice.privacy, recentMessagesCount: 50 },
    });
  });

  it('keeps the recent messages count visible but locked until recent messages are shared', async () => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const voice = {
      ...voiceSettingsDefaults,
      privacy: { ...voiceSettingsDefaults.privacy, shareRecentMessages: false, recentMessagesCount: 3 },
    };
    const screen = await renderScreen(React.createElement(VoicePrivacySection, { voice, setVoice }));

    const field = screen.findByTestId('settings.voice.privacy.recentMessagesCount.field');
    expect(field?.props.value).toBe('3');
    expect(field?.props.editable).toBe(false);
  });
});
