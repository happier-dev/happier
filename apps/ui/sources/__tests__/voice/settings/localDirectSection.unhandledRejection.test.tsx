import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => {
  type PlatformSelectOptions<T> = { web?: T; default?: T };
  return {
    Platform: { OS: 'web', select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default },
    TurboModuleRegistry: { getEnforcing: () => ({}) },
    Pressable: 'Pressable',
  };
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { textSecondary: '#666' } } }),
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));

vi.mock('@/voice/settings/panels/localStt/LocalVoiceSttGroup', () => ({ LocalVoiceSttGroup: () => null }));
vi.mock('@/voice/settings/panels/localTts/LocalVoiceTtsGroup', () => ({ LocalVoiceTtsGroup: () => null }));

const modalPrompt = vi.fn(async (..._args: any[]) => null);

vi.mock('@/modal', () => ({
  Modal: {
    prompt: modalPrompt as unknown as (...args: any[]) => Promise<string | null>,
  },
}));

import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

describe('LocalDirectSection', () => {
  it('does not produce an unhandledRejection when a prompt rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);

    modalPrompt.mockRejectedValueOnce(new Error('boom'));

    const { LocalDirectSection } = await import('@/voice/settings/panels/LocalDirectSection');

    try {
      const voice = voiceSettingsParse({ providerId: 'local_direct' });
      let tree: renderer.ReactTestRenderer;
      await act(async () => {
        tree = renderer.create(React.createElement(LocalDirectSection, { voice, setVoice: vi.fn() }));
        await Promise.resolve();
      });

      // @ts-expect-error assigned in act() above
      const networkTimeoutRow = tree.root.find(
        (node) => (node.type as any) === 'Item' && node.props?.title === 'Network timeout (ms)',
      );

      await act(async () => {
        networkTimeoutRow.props.onPress?.();
        await Promise.resolve();
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener('unhandledRejection', unhandledSpy);
      consoleError.mockRestore();
    }

    expect(unhandledSpy).not.toHaveBeenCalled();
  });
});
