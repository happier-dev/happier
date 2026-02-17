import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const decryptSecretValueMock = vi.fn((): string | null => null);

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

vi.mock('react-native-unistyles', () => {
  const theme = { colors: { textSecondary: '#666' } };
  return {
    useUnistyles: () => ({ theme }),
    StyleSheet: {
      create: (factory: any) => (typeof factory === 'function' ? {} : factory),
      absoluteFillObject: {},
    },
  };
});

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
    decryptSecretValue: decryptSecretValueMock,
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
  findExistingHappierElevenLabsAgents: vi.fn(),
}));

vi.mock('@/realtime/elevenlabs/elevenLabsVoices', () => ({
  listElevenLabsVoices: vi.fn(async () => []),
}));

vi.mock('@/voice/settings/modals/showElevenLabsAgentReuseDialog', () => ({
  showElevenLabsAgentReuseDialog: vi.fn(),
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
            voiceId: 'EST9Ui6982FZPSi7gCHi',
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

  it('wires welcome message selection into settings', async () => {
    const { RealtimeElevenLabsSection } = await import('./RealtimeElevenLabsSection');

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          assistantLanguage: null,
          welcome: { enabled: false, mode: 'immediate', templateId: null },
          byo: { agentId: null, apiKey: null },
          tts: {
            voiceId: 'EST9Ui6982FZPSi7gCHi',
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
    const welcomeDropdown = dropdowns.find((d: any) => Array.isArray(d.props?.items) && d.props.items.some((i: any) => i?.id === 'on_first_turn'));
    expect(welcomeDropdown).toBeTruthy();

    act(() => {
      welcomeDropdown!.props.onSelect?.('off');
    });

    expect(setVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: expect.objectContaining({
          realtime_elevenlabs: expect.objectContaining({
            welcome: expect.objectContaining({ enabled: false }),
          }),
        }),
      }),
    );
  });

  it('offers updating an existing Happier agent when it already exists', async () => {
    const { RealtimeElevenLabsSection } = await import('./RealtimeElevenLabsSection');
    const { createHappierElevenLabsAgent, updateHappierElevenLabsAgent, findExistingHappierElevenLabsAgents } = await import('@/realtime/elevenlabs/autoprovision');
    const { showElevenLabsAgentReuseDialog } = await import('@/voice/settings/modals/showElevenLabsAgentReuseDialog');

    decryptSecretValueMock.mockReturnValue('xi_test');
    (findExistingHappierElevenLabsAgents as any).mockResolvedValue([{ agentId: 'agent_existing', name: 'Happier Voice' }]);
    (showElevenLabsAgentReuseDialog as any).mockResolvedValue('update_existing');
    (updateHappierElevenLabsAgent as any).mockResolvedValue(undefined);

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          assistantLanguage: null,
          byo: { agentId: null, apiKey: { _isSecretValue: true, value: 'xi_test' } },
          tts: {
            voiceId: 'EST9Ui6982FZPSi7gCHi',
            modelId: null,
            voiceSettings: {
              stability: null,
              similarityBoost: null,
              style: null,
              useSpeakerBoost: null,
              speed: null,
            },
          },
          welcome: { enabled: false, mode: 'immediate', templateId: null },
        },
      },
    };

    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
      tree = renderer.create(React.createElement(RealtimeElevenLabsSection, { voice, setVoice }));
    });

    const createItem = tree!.root.findAllByType('Item' as any).find((n: any) => n.props?.title === 'settingsVoice.byo.autoprovCreate');
    expect(createItem).toBeTruthy();

    await act(async () => {
      await createItem!.props.onPress?.();
    });

    expect(createHappierElevenLabsAgent as any).not.toHaveBeenCalled();
    expect(updateHappierElevenLabsAgent as any).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'xi_test', agentId: 'agent_existing' }),
    );
    expect(setVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        adapters: expect.objectContaining({
          realtime_elevenlabs: expect.objectContaining({
            byo: expect.objectContaining({ agentId: 'agent_existing' }),
          }),
        }),
      }),
    );
  });
});
