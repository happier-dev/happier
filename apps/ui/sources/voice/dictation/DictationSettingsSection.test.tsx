import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installVoiceSettingsPanelCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
      View: (props: any) => React.createElement('View', props, props.children),
    });
  },
  icons: async () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
  }),
});

vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/voice/settings/panels/localStt/providers/registry', () => {
  const ProviderSettings = (props: any) => React.createElement('ProviderSettings', props);
  const specs = [
    {
      id: 'device',
      title: 'Device',
      subtitle: 'Device speech',
      iconName: 'mic-outline',
      Settings: ProviderSettings,
    },
    {
      id: 'openai_compat',
      title: 'OpenAI compatible',
      subtitle: 'Recorded audio',
      iconName: 'cloud-outline',
      Settings: ProviderSettings,
    },
  ];
  return {
    localSttProviderSpecs: specs,
    getLocalSttProviderSpec: (id: string) => specs.find((spec) => spec.id === id) ?? null,
  };
});

import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { DictationSettingsSection } from './DictationSettingsSection';

const localAvailability = {
  browserSpeech: {
    support: 'available',
    onDevice: 'available',
  },
  daemon: {
    featureEnabled: true,
    route: 'direct',
    modelState: 'ready',
    runtimeState: 'available',
  },
  nativeDevice: {
    requested: true,
    speechRecognition: 'available',
  },
} as never;

describe('DictationSettingsSection', () => {
  it('shows the visible same-as-local binding without rendering unrelated provider details', async () => {
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'same_as_local' as const,
      },
    };
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={vi.fn()}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
    });

    const providerPicker = tree.root.findAllByType('DropdownMenu' as any)
      .find((node) => node.props.itemTrigger?.title === 'settingsVoice.dictation.provider');
    expect(providerPicker?.props.selectedId).toBe('same_as_local');
    expect(providerPicker?.props.items.some((item: any) => item.id === 'same_as_local')).toBe(true);
    expect(tree.root.findAllByType('ProviderSettings' as any)).toHaveLength(0);
  });

  it('renders only the explicitly selected provider details and checks readiness passively', async () => {
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'device' as const,
        },
      },
    };
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
    });

    expect(tree.root.findAllByType('ProviderSettings' as any)).toHaveLength(1);
    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.checkSetup' }).props.onPress();
    });
    const readiness = tree.root.findByProps({ testID: 'settings.voice.dictation.readiness' });
    expect(readiness.props.subtitle).toBe('settingsVoice.dictation.readiness.ready');
    expect(readiness.props.detail).toBeUndefined();
    expect(setVoice).not.toHaveBeenCalled();
  });
});
