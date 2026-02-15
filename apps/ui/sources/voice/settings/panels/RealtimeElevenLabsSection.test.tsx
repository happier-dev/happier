import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
  const React = require('react');
  return {
    Linking: {
      canOpenURL: async () => true,
      openURL: async () => {},
    },
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { textSecondary: '#666' } } }),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => {
    const React = require('react');
    return React.createElement('Ionicons', props);
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(),
    confirm: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    decryptSecretValue: () => null,
  },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/realtime/elevenlabs/autoprovision', () => ({
  createHappierElevenLabsAgent: vi.fn(),
  updateHappierElevenLabsAgent: vi.fn(),
}));

vi.mock('@/realtime/elevenlabs/elevenLabsVoices', () => ({
  listElevenLabsVoices: vi.fn(async () => []),
}));

describe('RealtimeElevenLabsSection', () => {
  it('allows opening the voice dropdown even when API key is not set', async () => {
    const { RealtimeElevenLabsSection } = await import('./RealtimeElevenLabsSection');

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          assistantLanguage: null,
          byo: { agentId: null, apiKey: null },
          tts: {
            voiceId: 'MClEFoImJXBTgLwdLI5n',
            modelId: null,
            voiceSettings: {
              stability: null,
              similarityBoost: null,
              style: null,
              useSpeakerBoost: null,
              speed: null,
            },
          },
        },
      },
    };

    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
      tree = renderer.create(React.createElement(RealtimeElevenLabsSection, { voice, setVoice }));
    });

    const dropdowns = tree!.root.findAllByType('DropdownMenu' as any);
    const voiceDropdown = dropdowns.find((d: any) => d.props?.search === true && d.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder');
    expect(voiceDropdown).toBeTruthy();

    const toggle = vi.fn();
    const itemNode = voiceDropdown!.props.trigger({ open: false, toggle, openMenu: toggle, closeMenu: () => {} });
    expect(itemNode).toBeTruthy();
    expect(typeof itemNode.props.onPress).toBe('function');
    expect(itemNode.props.disabled).not.toBe(true);

    await act(async () => {
      itemNode.props.onPress?.();
    });

    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
