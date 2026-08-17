import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { VOICE_SETTINGS_INTENTS } from '@/voice/settings/voiceSettingsIntents';

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/utils/navigation/useNavigationFocusReturn', () => ({
  useNavigationFocusReturn: () => (navigate: () => void) => navigate,
}));

describe('VoiceSettingsIntentIndexScreen', () => {
  it('renders every landing description without a subtitle line limit', async () => {
    const { VoiceSettingsIntentIndexScreen } = await import('./VoiceSettingsIntentIndexScreen');
    const screen = await renderScreen(React.createElement(VoiceSettingsIntentIndexScreen));

    const rows = VOICE_SETTINGS_INTENTS.map((intent) => (
      screen.findByTestId(`settings.voice.intent.${intent.id}`)
    ));
    expect(rows.every(Boolean)).toBe(true);
    expect(rows.map((row) => row?.props.subtitleLines)).toEqual([0, 0, 0, 0]);
  });
});
