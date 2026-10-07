import React from 'react';
import { act } from 'react-test-renderer';
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
    storage: async () => await vi.importActual('@/sync/domains/state/storage'),
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


import { readLocalDirectVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

describe('LocalDirectSection', () => {
  // The network timeout used to be edited through an async `Modal.prompt`, whose rejection leaked as an
  // unhandledRejection. It is now an inline field: typing and leaving it commits a clamped value, with no
  // prompt and nothing left pending.
  it('commits the network timeout inline, clamped, without a prompt or an unhandledRejection', async () => {
    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);
    const setVoice = vi.fn();
    const { VoiceConnectionSection } = await import('@/voice/settings/panels/VoiceConnectionSection');

    try {
      const voice = voiceSettingsParse({ providerId: 'local_direct' });
      // Advanced connection settings owns the timeout for both local adapters.
      const screen = await renderSettingsView(React.createElement(VoiceConnectionSection, { voice, setVoice }));
      const field = () => screen.findByTestId('settings.voice.local.networkTimeoutMs.field')!.props;

      await act(async () => {
        field().onChangeText('999999');
      });
      await act(async () => {
        field().onBlur();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener('unhandledRejection', unhandledSpy);
    }

    expect(modalPrompt).not.toHaveBeenCalled();
    expect(setVoice).toHaveBeenCalledTimes(1);
    expect(readLocalDirectVoiceSettings(setVoice.mock.calls[0]![0]).networkTimeoutMs).toBe(60000);
    expect(unhandledSpy).not.toHaveBeenCalled();
  });

  it('passes daemon route diagnostics to local neural STT and TTS groups', async () => {
    const { LocalDirectSection } = await import('@/voice/settings/panels/LocalDirectSection');
    const { LocalVoiceSttGroup } = await import('@/voice/settings/panels/localStt/LocalVoiceSttGroup');
    const { LocalVoiceTtsGroup } = await import('@/voice/settings/panels/localTts/LocalVoiceTtsGroup');
    const voice = voiceSettingsParse({
      providerId: 'local_direct',
      providers: {
        local_direct: { schemaVersion: 1, config: {
          stt: { provider: 'local_neural' },
          tts: { provider: 'local_neural' },
        } },
      },
    });

    const screen = await renderSettingsView(React.createElement(LocalDirectSection, {
      voice,
      setVoice: vi.fn(),
      daemonRouteDiagnosticReason: 'daemon_relay_disabled',
    }));

    expect(screen.findByType(LocalVoiceSttGroup).props.daemonRouteDiagnosticReason).toBe('daemon_relay_disabled');
    expect(screen.findByType(LocalVoiceTtsGroup).props.daemonRouteDiagnosticReason).toBe('daemon_relay_disabled');
  });
});
