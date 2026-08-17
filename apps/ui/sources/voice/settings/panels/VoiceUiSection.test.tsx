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
      voiceOrbEnabled: true,
      setVoiceOrbEnabled: vi.fn(),
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
      t('settingsVoice.ui.orbEnabled'),
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

  it('offers both default scope choices and persists Session through the canonical voice setting', async () => {
    const setVoice = vi.fn();
    const { VoiceUiSection } = await import('./VoiceUiSection');
    const voice = {
      ...voiceSettingsDefaults,
      ui: {
        ...voiceSettingsDefaults.ui,
        scopeDefault: 'global' as const,
      },
    };
    const screen = await renderScreen(React.createElement(VoiceUiSection, {
      voice,
      setVoice,
      voiceOrbEnabled: true,
      setVoiceOrbEnabled: vi.fn(),
    }));

    const scopeMenu = screen.tree.root.findAllByType('DropdownMenu' as any)
      .find((menu) => menu.props.selectedId === 'global');
    expect(scopeMenu).toBeDefined();
    expect(scopeMenu?.props.items.map((item: { id: string }) => item.id)).toEqual([
      'global',
      'session',
    ]);

    scopeMenu?.props.onSelect('session');

    expect(setVoice).toHaveBeenCalledWith({
      ...voice,
      ui: {
        ...voice.ui,
        scopeDefault: 'session',
      },
    });
  });

  it('allows Voice Surface and Session updates descriptions to wrap in their settings rows', async () => {
    const { VoiceUiSection } = await import('./VoiceUiSection');
    const voice = {
      ...voiceSettingsDefaults,
      ui: {
        ...voiceSettingsDefaults.ui,
        activityFeedEnabled: true,
        updates: {
          ...voiceSettingsDefaults.ui.updates,
          activeSession: 'snippets' as const,
          otherSessions: 'snippets' as const,
        },
      },
    };
    const screen = await renderScreen(React.createElement(VoiceUiSection, {
      voice,
      setVoice: vi.fn(),
      voiceOrbEnabled: true,
      setVoiceOrbEnabled: vi.fn(),
    }));

    const descriptiveRows = screen.tree.root.findAllByType('Item' as any)
      .filter((item) => typeof item.props.subtitle === 'string');
    expect(descriptiveRows.map((item) => item.props.subtitleLines)).toEqual([
      0,
      0,
      0,
      0,
    ]);

    const descriptiveTriggers = screen.tree.root.findAllByType('DropdownMenu' as any)
      .map((menu) => menu.props.itemTrigger)
      .filter((trigger) => typeof trigger?.subtitle === 'string');
    expect(descriptiveTriggers.map((trigger) => trigger.itemProps?.subtitleLines)).toEqual([
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
  });
});
