import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { LocalConversationSection } from '@/voice/settings/panels/LocalConversationSection';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: { trigger?: (args: { open: boolean; toggle: () => void }) => React.ReactNode }) =>
    React.createElement(
      'DropdownMenu',
      {},
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : null,
    ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

function withProvider(voice: VoiceSettings, providerId: VoiceSettings['providerId']): VoiceSettings {
  return { ...voice, providerId };
}

describe('LocalConversationSection', () => {
  it('does not crash when providerId toggles away from local_conversation', () => {
    const setVoice = () => {};
    const initialVoice = withProvider(voiceSettingsDefaults, 'local_conversation');
    const nextVoice = withProvider(voiceSettingsDefaults, 'off');

    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={initialVoice} setVoice={setVoice} />);
    });

    expect(() => {
      act(() => {
        tree.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />);
      });
    }).not.toThrow();
  });
});
