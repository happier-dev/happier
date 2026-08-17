import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { installVoiceSettingsPanelCommonModuleMocks } from '@/voice/settings/panels/voiceSettingsPanelTestHelpers';
import type { LocalSttProviderSettingsProps } from '@/voice/settings/panels/localStt/providers/_types';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageBoundary = vi.hoisted(() => ({
  settings: null as unknown,
  platformOs: 'ios',
}));

installVoiceSettingsPanelCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        get OS() {
          return storageBoundary.platformOs;
        },
        select: (values: any) => values[storageBoundary.platformOs] ?? values.default,
      },
      View: (props: any) => React.createElement('View', props, props.children),
    });
  },
  icons: async () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
  }),
  storage: async () => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      useSettings: () => storageBoundary.settings ?? settingsParse({}),
    });
  },
});

vi.mock('@/text', () => ({
  t: (key: string) => key,
  tLoose: (key: string) => key,
}));
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
  const ProviderSettings = (props: LocalSttProviderSettingsProps) => React.createElement('ProviderSettings', props);
  const specs = [
    {
      id: 'device',
      title: 'Device',
      subtitle: 'Device speech',
      iconName: 'microphone',
      Settings: ProviderSettings,
    },
    {
      id: 'happier.voice.openai-compat/stt',
      title: 'OpenAI compatible',
      subtitle: 'Recorded audio',
      iconName: 'cloud',
      Settings: ProviderSettings,
    },
    {
      id: 'acme.dictation/stt',
      title: 'Acme Dictation',
      subtitle: 'Configurable external speech',
      iconName: 'cloud',
      Settings: ProviderSettings,
    },
  ];
  return {
    useLocalSttProviderSpecs: () => specs,
    getLocalSttProviderSpec: (id: string) => specs.find((spec) => spec.id === id) ?? null,
  };
});

import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

const EXTERNAL_DICTATION_STT_PROVIDER_ID = 'acme.dictation/stt';

function registerExternalDictationSttProvider(): void {
  const declaration = VoiceProviderContributionSchema.parse({
    id: 'stt',
    title: 'Acme Dictation',
    kind: 'speech',
    roles: ['dictation_stt'],
    platforms: ['ios'],
    settings: {
      schemaVersion: 2,
      fields: [{
        id: 'model',
        title: 'Model',
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        default: 'acme-default',
        presentation: { control: 'text' },
      }],
    },
  });
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  const descriptor = createVoiceProviderRegistry({
    bundledContributions: [{
      pluginId: 'acme.dictation',
      providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
      declaration,
    }],
    bundledPresentations: [{
      providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
      settingsSectionId: 'voice.acme.dictation',
      createSettingsSpec: () => ({
        titleKey: 'Acme Dictation',
        subtitleKey: 'Configurable external speech',
        detailKey: 'Configurable external speech',
        iconName: 'cloud',
        fields: [{
          fieldId: 'model',
          titleKey: 'Model',
          subtitleKey: 'Model',
        }],
        test: null,
      }),
    }],
  }).get(EXTERNAL_DICTATION_STT_PROVIDER_ID);
  if (!descriptor) throw new Error('expected external Voice descriptor');
  const token = {};
  commitExternalVoiceProviderRegistration({
    token,
    pluginId: 'acme.dictation',
    localId: 'stt',
    providerId: EXTERNAL_DICTATION_STT_PROVIDER_ID,
    descriptor,
    adapter: null,
  });
  onTestFinished(() => removeExternalVoiceProviderRegistration(token));
}

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
} as const satisfies VoiceProviderLocalAvailability;

describe('DictationSettingsSection', () => {
  it('seeds an external provider default envelope atomically with an explicit Dictation selection', async () => {
    registerExternalDictationSttProvider();
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voiceSettingsDefaults}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
    });

    const providerPicker = tree.root.findAllByType('DropdownMenu' as any)
      .find((node) => node.props.itemTrigger?.title === 'settingsVoice.dictation.provider');
    expect(providerPicker).toBeTruthy();
    await act(async () => {
      providerPicker!.props.onSelect(EXTERNAL_DICTATION_STT_PROVIDER_ID);
    });

    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      dictation: expect.objectContaining({
        sttBinding: 'explicit',
        stt: expect.objectContaining({ provider: EXTERNAL_DICTATION_STT_PROVIDER_ID }),
      }),
      providers: expect.objectContaining({
        [EXTERNAL_DICTATION_STT_PROVIDER_ID]: {
          schemaVersion: 2,
          config: { model: 'acme-default' },
        },
      }),
    }));
  });

  it.each([
    ['an invalid current-version', { schemaVersion: 2, config: { model: 42 } }],
    ['a future-version', { schemaVersion: 3, config: { model: 'future', addedByFutureVersion: true } }],
  ])('does not overwrite %s external provider envelope when selecting Dictation', async (_case, envelope) => {
    registerExternalDictationSttProvider();
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const voice = voiceSettingsParse({
      ...voiceSettingsDefaults,
      providers: {
        ...voiceSettingsDefaults.providers,
        [EXTERNAL_DICTATION_STT_PROVIDER_ID]: envelope,
      },
    });
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

    const providerPicker = tree.root.findAllByType('DropdownMenu' as any)
      .find((node) => node.props.itemTrigger?.title === 'settingsVoice.dictation.provider');
    await act(async () => {
      providerPicker!.props.onSelect(EXTERNAL_DICTATION_STT_PROVIDER_ID);
    });

    expect(setVoice).toHaveBeenCalledOnce();
    expect(setVoice.mock.calls[0]?.[0].providers[EXTERNAL_DICTATION_STT_PROVIDER_ID]).toEqual(envelope);
  });

  it('edits the canonical Local Voice STT settings when Dictation follows Local Voice', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'same_as_local' as const,
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

    const providerPicker = tree.root.findAllByType('DropdownMenu' as any)
      .find((node) => node.props.itemTrigger?.title === 'settingsVoice.dictation.provider');
    expect(providerPicker?.props.selectedId).toBe('same_as_local');
    expect(providerPicker?.props.items.some((item: any) => item.id === 'same_as_local')).toBe(true);
    const providerSettings = tree.root.findAllByType('ProviderSettings' as any);
    expect(providerSettings).toHaveLength(1);
    await act(async () => {
      providerSettings[0]!.props.setStt({
        ...providerSettings[0]!.props.cfgStt,
        provider: 'happier.voice.openai-compat/stt',
      });
    });
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0]).stt.provider)
      .toBe('happier.voice.openai-compat/stt');
  });

  it('renders only the explicitly selected provider details and checks readiness passively', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
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

    const providerSettings = tree.root.findAllByType('ProviderSettings' as any);
    expect(providerSettings).toHaveLength(1);
    expect(providerSettings[0]?.props.voice).toBe(voice);
    expect(providerSettings[0]?.props.setVoice).toBe(setVoice);
    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.checkSetup' }).props.onPress();
    });
    const readiness = tree.root.findByProps({ testID: 'settings.voice.dictation.readiness' });
    expect(readiness.props.subtitle).toBe('settingsVoice.dictation.readiness.ready');
    expect(readiness.props.detail).toBeUndefined();
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('renders unsupported web Device Dictation as unavailable from passive support facts', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
    });
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
    const onRecoveryAction = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={{
          ...localAvailability,
          browserSpeech: {
            support: 'unavailable',
            onDevice: 'unsupported',
          },
        }}
        onRecoveryAction={onRecoveryAction}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.checkSetup' }).props.onPress();
    });

    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe(
      'voice.readiness.device_stt_unavailable · voice.readiness.actions.switch_provider',
    );
    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.readiness' }).props.onPress();
    });
    expect(onRecoveryAction).toHaveBeenCalledWith('switch_provider');
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('explains when daemon-backed Dictation has no policy-allowed heavy-audio route', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
    });
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'local_neural' as const,
          localNeural: {
            ...voiceSettingsDefaults.dictation.stt.localNeural,
            execution: 'daemon' as const,
          },
        },
      },
    };
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={setVoice}
        executionMachineId="machine-online"
        localAvailability={{
          ...localAvailability,
          daemon: {
            ...localAvailability.daemon,
            route: 'relay_disabled',
          },
        }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.checkSetup' }).props.onPress();
    });

    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe(
      'voice.readiness.daemon_relay_disabled · voice.readiness.actions.switch_provider',
    );
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('reprojects checked credential readiness after the selected secret is removed', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { upsertAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
    const voice = {
      ...voiceSettingsDefaults,
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'happier.voice.google/gemini-stt' as const,
        },
      },
    };
    const ready = upsertAccountVoiceCredential({
      settings: settingsParse({ voice }),
      contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      credentialSlotId: 'api_key',
      machineId: 'machine-online',
      value: 'google-stt-key',
      generateId: () => 'google-stt-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    storageBoundary.settings = ready;
    onTestFinished(() => {
      storageBoundary.settings = null;
    });
    const setVoice = vi.fn();
    const render = (nextVoice: typeof ready.voice) => <DictationSettingsSection
      voice={nextVoice}
      setVoice={setVoice}
      executionMachineId="machine-online"
      localAvailability={localAvailability}
    />;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(render(ready.voice));
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'settings.voice.dictation.checkSetup' }).props.onPress();
    });
    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe('settingsVoice.dictation.readiness.ready');

    const removed = settingsParse({ ...ready, secrets: [] });
    storageBoundary.settings = removed;
    await act(async () => {
      tree.update(render(removed.voice));
    });

    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe(
      'voice.readiness.credential_missing · voice.readiness.actions.configure_credential',
    );
    expect(setVoice).not.toHaveBeenCalled();
  });
});
