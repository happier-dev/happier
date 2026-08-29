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
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageBoundary = vi.hoisted(() => ({
  settings: null as unknown,
  platformOs: 'ios',
}));
const nativeModelReadiness = vi.hoisted(() => ({
  read: vi.fn(),
}));
const providerFocus = vi.hoisted(() => vi.fn());
const rawCredentialReadiness = vi.hoisted(() => vi.fn(async () => 'ready' as const));

installVoiceSettingsPanelCommonModuleMocks({
  reactNative: async () => {
    const {
      createFocusablePressableMock,
      createReactNativeWebMock,
    } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Platform: {
        get OS() {
          return storageBoundary.platformOs;
        },
        select: (values: any) => values[storageBoundary.platformOs] ?? values.default,
      },
      View: (props: any) => React.createElement('View', props, props.children),
      Pressable: createFocusablePressableMock(providerFocus),
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
vi.mock('@/voice/credentials/rawCredentialAuthorizationClient', () => ({
  inspectRawCredentialAuthorizationReadiness: rawCredentialReadiness,
  rawCredentialAuthorizationClient: {
    inspect: vi.fn(async () => { throw new Error('unavailable'); }),
    request: vi.fn(async () => { throw new Error('unavailable'); }),
  },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
  ItemGroupSelectionContext: React.createContext(null),
}));
vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
  useItemGroupRowPosition: () => 'middle',
}));
vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
  getItemGroupRowCornerRadii: () => ({}),
}));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
  normalizeNodeForView: (node: unknown) => node,
}));
vi.mock('@/components/ui/text/Text', () => ({
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));
vi.mock('@/constants/Typography', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants/Typography')>();
  return {
    ...actual,
    Typography: {
      ...actual.Typography,
      default: () => ({}),
      rowMeta: () => ({}),
    },
  };
});
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(),
}));
vi.mock('@/sync/store/hooks', () => ({
  useSettingsVersion: () => 1,
  useLocalSetting: (key: string) => {
    if (key === 'uiItemDensity') return 'comfortable';
    if (key === 'uiFontScale') return 1;
    return null;
  },
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', async () => {
  const { Item } = await import('@/components/ui/lists/Item');
  return {
    DropdownMenu: (props: any) => React.createElement(
      'DropdownMenu',
      props,
      props.itemTrigger
        ? React.createElement(Item, {
            ...props.itemTrigger.itemProps,
            title: props.itemTrigger.title,
            subtitle: props.itemTrigger.subtitle,
            accessibilityRole: 'button',
            onPress: () => props.onOpenChange(!props.open),
          })
        : null,
    ),
  };
});
vi.mock('@/voice/dictation/voiceDictationNativeModelReadiness', () => ({
  readVoiceDictationNativeModelReadiness: (...args: unknown[]) => nativeModelReadiness.read(...args),
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
  readLocalDirectVoiceSettings,
  voiceSettingsDefaults,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeLocalDirectVoiceSettings,
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

function findRenderedItem(tree: ReturnType<typeof create>, testID: string) {
  const item = tree.root
    .findAll((node) => node.props.testID === testID)
    .at(0);
  if (!item) throw new Error(`Missing rendered Item: ${testID}`);
  return item;
}

function findRenderedPressable(tree: ReturnType<typeof create>, testID: string) {
  const pressable = tree.root
    .findAllByType('Pressable' as any)
    .find((node) => node.props.testID === testID);
  if (!pressable) throw new Error(`Missing rendered Pressable: ${testID}`);
  return pressable;
}

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

  it('edits the selected Local Voice adapter STT settings when Dictation follows Local Voice', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings(writeLocalDirectVoiceSettings({
      ...voiceSettingsDefaults,
      providerId: 'local_direct',
    }, {
      ...localDirect,
      stt: {
        ...localDirect.stt,
        provider: 'device',
      },
    }), {
      ...localConversation,
      stt: {
        ...localConversation.stt,
        provider: 'happier.voice.openai-compat/stt',
      },
    });
    const dictationVoice = {
      ...voice,
      dictation: {
        ...voice.dictation,
        sttBinding: 'same_as_local' as const,
      },
    };
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={dictationVoice}
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
    expect(readLocalDirectVoiceSettings(setVoice.mock.calls[0]![0]).stt.provider)
      .toBe('happier.voice.openai-compat/stt');
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
      findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.onPress();
    });
    const readiness = tree.root.findByProps({ testID: 'settings.voice.dictation.readiness' });
    expect(readiness.props.subtitle).toBe('settingsVoice.dictation.readiness.ready');
    expect(readiness.props.detail).toBeUndefined();
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('checks the exact selected native Local Neural pack once while the passive check is pending', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const withDirectPack = writeLocalDirectVoiceSettings({
      ...voiceSettingsDefaults,
      providerId: 'local_direct',
    }, {
      ...localDirect,
      stt: {
        ...localDirect.stt,
        provider: 'local_neural',
        localNeural: {
          ...localDirect.stt.localNeural,
          assetId: 'selected-direct-pack',
          execution: 'device',
        },
      },
    });
    const voice = writeLocalConversationVoiceSettings(withDirectPack, {
      ...localConversation,
      stt: {
        ...localConversation.stt,
        provider: 'local_neural',
        localNeural: {
          ...localConversation.stt.localNeural,
          assetId: 'unselected-conversation-pack',
          execution: 'device',
        },
      },
    });
    let settleModelReadiness!: (value: 'ready') => void;
    const pendingModelReadiness = new Promise<'ready'>((resolve) => {
      settleModelReadiness = resolve;
    });
    nativeModelReadiness.read.mockReset();
    nativeModelReadiness.read.mockReturnValue(pendingModelReadiness);
    onTestFinished(() => {
      nativeModelReadiness.read.mockReset();
    });
    const setVoice = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={{
          ...voice,
          dictation: {
            ...voice.dictation,
            sttBinding: 'same_as_local',
          },
        }}
        setVoice={setVoice}
        executionMachineId={null}
        localAvailability={localAvailability}
      />);
    });

    const checkSetup = findRenderedItem(tree, 'settings.voice.dictation.checkSetup');
    await act(async () => {
      checkSetup.props.onPress();
      checkSetup.props.onPress();
    });

    expect(nativeModelReadiness.read).toHaveBeenCalledTimes(1);
    expect(nativeModelReadiness.read).toHaveBeenCalledWith('selected-direct-pack');
    expect(findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.disabled).toBe(true);

    await act(async () => {
      settleModelReadiness('ready');
      await Promise.resolve();
    });

    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe('settingsVoice.dictation.readiness.ready');
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
      findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.onPress();
    });

    expect(tree.root.findByProps({
      testID: 'settings.voice.dictation.readiness',
    }).props.subtitle).toBe(
      'voice.readiness.device_stt_unavailable · voice.readiness.actions.switch_provider',
    );
    await act(async () => {
      findRenderedPressable(tree, 'settings.voice.dictation.readiness').props.onPress();
    });
    expect(onRecoveryAction).toHaveBeenCalledWith('switch_provider');
    expect(setVoice).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(<DictationSettingsSection
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
      />);
    });
    expect(tree.root.findAllByType('Pressable' as any).filter(
      (node) => node.props.testID === 'settings.voice.dictation.readiness',
    )).toHaveLength(0);
  });

  it('returns switch-provider recovery focus to the provider control on every activation', async () => {
    const { DictationSettingsSection } = await import('./DictationSettingsSection');
    storageBoundary.platformOs = 'web';
    providerFocus.mockClear();
    onTestFinished(() => {
      storageBoundary.platformOs = 'ios';
      providerFocus.mockClear();
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
    const onRecoveryAction = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DictationSettingsSection
        voice={voice}
        setVoice={vi.fn()}
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
      findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.onPress();
    });

    const recovery = findRenderedPressable(tree, 'settings.voice.dictation.readiness');
    await act(async () => {
      recovery.props.onPress();
      recovery.props.onPress();
    });

    expect(providerFocus).toHaveBeenCalledTimes(2);
    expect(onRecoveryAction).toHaveBeenNthCalledWith(1, 'switch_provider');
    expect(onRecoveryAction).toHaveBeenNthCalledWith(2, 'switch_provider');
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
      findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.onPress();
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
    const { saveAndUseAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
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
    const declaration = createDefaultVoiceProviderRegistry()
      .get('happier.voice.google/gemini-stt')?.declaration;
    if (declaration?.kind !== 'speech') throw new Error('Expected Gemini STT declaration');
    const ready = saveAndUseAccountVoiceCredential({
      settings: settingsParse({ voice }),
      contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      credentialSlotId: 'api_key',
      expectedSettingsVersion: 0,
      currentDeclaration: declaration,
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
      findRenderedItem(tree, 'settings.voice.dictation.checkSetup').props.onPress();
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
