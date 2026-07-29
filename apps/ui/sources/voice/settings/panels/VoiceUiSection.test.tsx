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

describe('VoiceUiSection', () => {
  it('exposes a stable, labelled activity-feed switch and updates the canonical UI setting', async () => {
    const setVoice = vi.fn();
    const { VoiceUiSection } = await import('./VoiceUiSection');
    const voice = {
      ...voiceSettingsDefaults,
      ui: {
        ...voiceSettingsDefaults.ui,
        activityFeedEnabled: true,
        updates: {
          ...voiceSettingsDefaults.ui.updates,
          activeSession: 'snippets' as const,
        },
      },
    };
    const screen = await renderScreen(React.createElement(VoiceUiSection, {
      voice,
      setVoice,
    }));

    const activityFeedSwitch = screen.findByProps({
      testID: 'settings.voice.ui.activityFeedEnabled',
    });
    expect(activityFeedSwitch.props.accessibilityLabel).toBe(t('settingsVoice.ui.activityFeedEnabled'));
    expect(
      screen.tree.root.findAllByType('Switch' as any)
        .map((control) => control.props.accessibilityLabel),
    ).toEqual([
      t('settingsVoice.ui.activityFeedEnabled'),
      t('settingsVoice.ui.activityFeedAutoExpandOnStart'),
      t('settingsVoice.ui.updates.includeUserMessagesInSnippetsTitle'),
    ]);

    activityFeedSwitch.props.onValueChange(true);

    expect(setVoice).toHaveBeenCalledWith({
      ...voice,
      ui: {
        ...voice.ui,
        activityFeedEnabled: true,
      },
    });
  });
});
