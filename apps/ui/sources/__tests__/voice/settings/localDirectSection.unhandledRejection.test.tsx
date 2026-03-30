import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit';
import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';

type PlatformSelectOptions<T> = {
    web?: T;
    default?: T;
};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const modalPrompt = vi.fn(async (..._args: any[]) => null);

installVoiceSettingsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default,
            },
            TurboModuleRegistry: {
                getEnforcing: () => ({}),
            },
            Pressable: 'Pressable',
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPrompt as unknown as (...args: any[]) => Promise<string | null>,
            },
        }).module;
    },
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { textSecondary: '#666' } },
        });
    },
});

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));

vi.mock('@/voice/settings/panels/localStt/LocalVoiceSttGroup', () => ({ LocalVoiceSttGroup: () => null }));
vi.mock('@/voice/settings/panels/localTts/LocalVoiceTtsGroup', () => ({ LocalVoiceTtsGroup: () => null }));

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
      const screen = await renderSettingsView(React.createElement(LocalDirectSection, { voice, setVoice: vi.fn() }));

      expect(screen.findRowByTitle('settingsVoice.local.conversation.network.timeoutTitle')).toBeTruthy();

      screen.pressRowByTitle('settingsVoice.local.conversation.network.timeoutTitle');

      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener('unhandledRejection', unhandledSpy);
      consoleError.mockRestore();
    }

    expect(unhandledSpy).not.toHaveBeenCalled();
  });
});
