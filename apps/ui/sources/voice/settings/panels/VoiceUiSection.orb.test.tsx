import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.rightElement),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

/**
 * The orb row is a **device-local** preference sitting among synced siblings, so ownership is the
 * contract under test: the section stays presentational — it receives the value and the mutation
 * from the settings route and never reads MMKV itself. This suite therefore installs **no storage
 * mock at all**; if the section ever reaches for `useLocalSettingMutable`, it fails here.
 */
describe('VoiceUiSection orb row', () => {
  it('renders the device-local orb switch from props and reports changes to the owner', async () => {
    const setVoice = vi.fn();
    const setVoiceOrbEnabled = vi.fn();
    const { VoiceUiSection } = await import('./VoiceUiSection');
    const voice = {
      ...voiceSettingsDefaults,
      ui: { ...voiceSettingsDefaults.ui, activityFeedEnabled: true },
    };
    const screen = await renderScreen(React.createElement(VoiceUiSection, {
      voice,
      setVoice,
      voiceOrbEnabled: false,
      setVoiceOrbEnabled,
    }));

    const orbSwitch = screen.findByProps({ testID: 'settings.voice.ui.orbEnabled' });
    expect(orbSwitch.props.value).toBe(false);
    expect(orbSwitch.props.accessibilityLabel).toBe(t('settingsVoice.ui.orbEnabled'));

    orbSwitch.props.onValueChange(true);
    expect(setVoiceOrbEnabled).toHaveBeenCalledWith(true);
    // A device-local preference must never be written into the synced voice settings tree.
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('places the orb row directly after auto-expand and before the scope dropdown', async () => {
    const { VoiceUiSection } = await import('./VoiceUiSection');
    const voice = {
      ...voiceSettingsDefaults,
      ui: { ...voiceSettingsDefaults.ui, activityFeedEnabled: true },
    };
    const screen = await renderScreen(React.createElement(VoiceUiSection, {
      voice,
      setVoice: vi.fn(),
      voiceOrbEnabled: true,
      setVoiceOrbEnabled: vi.fn(),
    }));

    expect(
      screen.tree.root.findAllByType('Item' as any).map((item) => item.props.title),
    ).toEqual([
      t('settingsVoice.ui.activityFeedEnabled'),
      t('settingsVoice.ui.activityFeedAutoExpandOnStart'),
      t('settingsVoice.ui.orbEnabled'),
    ]);
    expect(screen.findByProps({ testID: 'settings.voice.ui.orbEnabled' }).props.value).toBe(true);
    // "this device" has to be stated: a local setting among synced siblings is how a
    // "why didn't this sync?" bug is born.
    expect(t('settingsVoice.ui.orbEnabledSubtitle')).toContain('this device');
  });
});
