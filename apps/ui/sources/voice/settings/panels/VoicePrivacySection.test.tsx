import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
afterEach(() => {
  standardCleanup();
  vi.useRealTimers();
});

describe('VoicePrivacySection', () => {
  it('names every privacy switch and updates the canonical privacy setting', async () => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    vi.useFakeTimers();
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
    // The real native Switch adapter defers mounting; settle its clock boundary, not the component.
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const switches = screen.findAll((node) => typeof node.type === 'string' && String(node.type) === 'Switch');
    expect(switches.map((control) => control.props.accessibilityLabel)).toEqual(expectedLabels);

    await act(async () => { switches[0]!.props.onValueChange(!voiceSettingsDefaults.privacy.shareSessionSummary); });
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

    await screen.pressByTestIdAsync(`settings.voice.privacy.currentUiContextMode:${currentUiContextMode}`);
    expect(setVoice).toHaveBeenCalledWith({
      ...voiceSettingsDefaults,
      privacy: {
        ...voiceSettingsDefaults.privacy,
        currentUiContextMode,
      },
    });
    },
  );
  it.each([
    ['80', 80],
    ['0', 0],
  ] as const)('commits recent messages count %s as the canonical nonnegative value %i', async (draft, expectedCount) => {
    const setVoice = vi.fn();
    const { VoicePrivacySection } = await import('./VoicePrivacySection');
    const voice = {
      ...voiceSettingsDefaults,
      privacy: { ...voiceSettingsDefaults.privacy, shareRecentMessages: true, recentMessagesCount: 3 },
    };
    const screen = await renderScreen(React.createElement(VoicePrivacySection, { voice, setVoice }));

    const field = () => screen.findByTestId('settings.voice.privacy.recentMessagesCount.field');
    expect(field()?.props.value).toBe('3');
    await act(async () => {
      field()!.props.onChangeText(draft);
    });
    await act(async () => {
      field()!.props.onBlur();
    });

    expect(setVoice).toHaveBeenLastCalledWith({
      ...voice,
      privacy: { ...voice.privacy, recentMessagesCount: expectedCount },
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
