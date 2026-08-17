import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import {
  OpenAiRealtimeSettingsV1Schema,
} from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const credentialState = vi.hoisted(() => ({
  exists: false,
  reviewRequired: false,
}));
const publicSettingsRegistrationState = vi.hoisted(() => ({ available: true }));
const defaultRegistrationToken = Object.freeze({});
const bundledUiSpies = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  findExistingAgents: vi.fn(),
  listVoices: vi.fn(async () => []),
}));
const canonicalAccountSettings = vi.hoisted(() => ({
  version: 1,
  voice: {} as any,
}));

installVoiceSettingsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: {
                canOpenURL: async () => true,
                openURL: async () => {},
            },
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
    icons: async () => ({
        Ionicons: (props: any) => React.createElement('Ionicons', props),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const snapshot = () => ({
            settings: {
                voice: canonicalAccountSettings.voice,
            },
        });
        return createStorageModuleStub({
            storage: Object.assign(
                (selector?: (value: ReturnType<typeof snapshot>) => unknown) => (
                    typeof selector === 'function' ? selector(snapshot()) : snapshot()
                ),
                {
                    getState: snapshot,
                    setState: vi.fn(),
                    subscribe: () => () => {},
                },
            ),
        });
    },
});

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({
    prepareAccountSettingsForDaemonSpawn: async () => ({
      accountSettingsVersionHint: canonicalAccountSettings.version,
    }),
    mutateAccountSettingsOnce: async (input: any) => {
      const result = input.mutate({ voiceSettingsV1: canonicalAccountSettings.voice });
      canonicalAccountSettings.voice = result.settings.voiceSettingsV1;
      canonicalAccountSettings.version += 1;
      return { status: 'applied', settingsVersion: canonicalAccountSettings.version, value: result.value };
    },
  }),
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

vi.mock('@/voice/credentials/bundledConversationClient', () => ({
  createBundledConversationUi: (providerId: string) => {
    if (
      providerId === 'acme.connected/connected-conversation'
      || providerId === 'acme.multi/multi-conversation'
    ) return {
      settingsDescriptor: {
        kind: 'voice.internal.realtime-settings.v1',
        providerId,
        mode: 'byo',
        credential: {
          kind: 'api_key',
          catalog: null,
          credentialPurpose: 'voice.client-auth',
        },
        links: {},
        fields: [],
      },
      settingsOwner: {
        currentSchemaVersion: 1,
        defaultConfig: OpenAiRealtimeSettingsV1Schema.parse({}),
        parseConfig: (value: unknown) => {
          const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      },
      client: null,
      autoprovision: null,
    };
    if (providerId !== 'happier.voice.elevenlabs/realtime-elevenlabs') return null;
    const contribution = {
    settingsDescriptor: {
      kind: 'voice.internal.conversation-settings.v1',
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      modes: ['happier', 'byo'],
      titleKey: 'settingsVoice.byo.title',
      footerKey: 'settingsVoice.byo.provisioningGroupFooter',
      credential: {
        kind: 'api_key', catalog: 'voices',
        credentialPurpose: 'voice.client-auth.signed-url',
        titleKey: 'settingsVoice.byo.apiKeyTitle',
        promptTitleKey: 'settingsVoice.byo.apiKeyTitle',
        promptBodyKey: 'settingsVoice.byo.apiKeyDescription',
      },
      links: {},
      fields: [
        { kind: 'welcome', path: 'welcome', titleKey: 'settingsVoice.byo.realtime.call.welcome.title', subtitleKey: 'settingsVoice.byo.realtime.call.welcome.subtitle' },
        { kind: 'text', path: 'agentId', titleKey: 'settingsVoice.byo.agentIdTitle', subtitleKey: 'settingsVoice.byo.agentIdDescription' },
        { kind: 'remote_voice', path: 'tts.voiceId', catalog: 'voices', titleKey: 'settingsVoice.byo.realtime.voicePicker.title', subtitleKey: 'settingsVoice.byo.realtime.voicePicker.subtitle', searchPlaceholderKey: 'settingsVoice.byo.voiceSearchPlaceholder' },
        { kind: 'select', path: 'tts.modelId', titleKey: 'settingsVoice.byo.realtime.modelPicker.title', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.subtitle', options: [{ id: '', title: 'Auto' }] },
      ],
    },
    settingsOwner: {
      currentSchemaVersion: 2,
      // Mirrors the real contribution: the shipped default comes from the
      // plugin manifest, never from a literal copied into this test double.
      defaultConfig: {
        billingMode: 'byo',
        agentId: '',
        tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
      },
      parseConfig: (value: unknown) => {
        const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
      readLegacySecret: (value: any) => value?.byo?.apiKey ?? null,
      migrateLegacy: (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const legacy = value as Record<string, unknown>;
        const legacyTts = legacy.tts && typeof legacy.tts === 'object' && !Array.isArray(legacy.tts)
          ? legacy.tts as Record<string, unknown>
          : {};
        const legacyByo = legacy.byo && typeof legacy.byo === 'object' && !Array.isArray(legacy.byo)
          ? legacy.byo as Record<string, unknown>
          : {};
        const legacyVoiceSettings = legacyTts.voiceSettings
          && typeof legacyTts.voiceSettings === 'object'
          && !Array.isArray(legacyTts.voiceSettings)
          ? legacyTts.voiceSettings as Record<string, unknown>
          : {};
        const supportedVoiceSettings = Object.fromEntries(
          Object.keys(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceSettings)
            .map((key) => [key, legacyVoiceSettings[key] ?? null]),
        );
        const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse({
          billingMode: legacy.billingMode,
          tts: { ...legacyTts, voiceSettings: supportedVoiceSettings },
          agentId: typeof legacyByo.agentId === 'string' ? legacyByo.agentId : '',
        });
        return parsed.success ? { config: parsed.data } : null;
      },
    },
    client: publicSettingsRegistrationState.available ? {
      fetchVoiceCatalog: bundledUiSpies.listVoices,
    } : null,
    };
    return contribution;
  },
}));

vi.mock('@/voice/credentials/CredentialItem', () => ({
  VoiceCredentialItem: (props: any) => {
    React.useEffect(() => {
      props.onStatusChanged?.({
        status: credentialState.reviewRequired
          ? 'review_required'
          : credentialState.exists ? 'ready' : 'missing',
        exists: credentialState.exists,
        usable: credentialState.exists && !credentialState.reviewRequired,
        source: credentialState.exists ? 'account' : null,
        credentialIdentity: credentialState.exists ? 'credential' : null,
      });
    }, [props.onStatusChanged]);
    return React.createElement('VoiceCredentialItem', props);
  },
}));

vi.mock('./realtime/VoiceCredentialSourceField', () => ({
  VoiceCredentialSourceField: (props: any) => React.createElement('VoiceCredentialSourceField', props),
}));

describe('BundledConversationSettingsSection', () => {
  beforeEach(() => {
    credentialState.exists = false;
    credentialState.reviewRequired = false;
    publicSettingsRegistrationState.available = true;
    bundledUiSpies.createAgent.mockReset();
    bundledUiSpies.updateAgent.mockReset();
    bundledUiSpies.findExistingAgents.mockReset();
    bundledUiSpies.listVoices.mockReset();
    bundledUiSpies.listVoices.mockResolvedValue([]);
    canonicalAccountSettings.version = 1;
    canonicalAccountSettings.voice = voiceSettingsParse({
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            agentId: '',
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi',
              modelId: null,
              voiceSettings: {
                stability: null,
                similarityBoost: null,
                speed: null,
              },
            },
          },
        },
      },
    });
    commitExternalVoiceProviderRegistration(Object.freeze({
      token: defaultRegistrationToken,
      pluginId: 'happier.voice.elevenlabs',
      localId: 'realtime-elevenlabs',
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      descriptor: null,
      adapter: null,
      settingsActions: Object.freeze({
        async execute(input: Readonly<{
          actionId: string;
          settings: Readonly<Record<string, unknown>>;
          signal: AbortSignal;
        }>) {
          if (input.actionId === 'create-agent') {
            const existing = await bundledUiSpies.findExistingAgents(input.signal);
            input.signal.throwIfAborted();
            if (existing[0]) {
              await bundledUiSpies.updateAgent({
                agentId: existing[0].agentId,
                tts: input.settings.tts,
              }, input.signal);
              return Object.freeze({ patch: Object.freeze({ agentId: existing[0].agentId }) });
            }
            const created = await bundledUiSpies.createAgent({ tts: input.settings.tts }, input.signal);
            input.signal.throwIfAborted();
            return Object.freeze({ patch: Object.freeze({ agentId: created.agentId }) });
          }
          if (input.actionId === 'update-agent') {
            await bundledUiSpies.updateAgent({
              agentId: input.settings.agentId,
              tts: input.settings.tts,
            }, input.signal);
            input.signal.throwIfAborted();
            return Object.freeze({ patch: Object.freeze({ agentId: input.settings.agentId }) });
          }
          throw new Error('unsupported_test_action');
        },
      }),
    }));
  });

  afterEach(async () => {
    await act(async () => {
      removeExternalVoiceProviderRegistration(defaultRegistrationToken);
    });
  });

  it('renders only the canonical source selector for a Connected Account-only conversation', async () => {
    const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
    const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
    const base = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    if (base?.kind !== 'voice.conversation-provider.v1'
      || base.declaration?.kind !== 'conversation'
      || !base.declaration.credentials) {
      throw new Error('expected OpenAI conversation declaration');
    }
    const connectedSource = base.declaration.credentials.sources.find(
      (source) => source.kind === 'connectedAccount',
    );
    if (!connectedSource) throw new Error('expected Connected Account source');
    const providerId = 'acme.connected/connected-conversation';
    const descriptor = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.connected',
        providerId,
        declaration: {
          ...base.declaration,
          id: 'connected-conversation',
          credentials: {
            ...base.declaration.credentials,
            sources: [connectedSource],
          },
        },
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.connected-conversation',
        selectionOptions: [{
          id: 'byo',
          modeId: 'byo',
          order: 10,
          titleKey: 'Connected conversation',
          subtitleKey: 'Connected conversation subtitle',
          configPatch: {},
        }],
        createSettingsSection: () => ({
          kind: 'voice.internal.realtime-settings.v1',
          providerId,
          mode: 'byo',
          credential: {
            kind: 'api_key',
            catalog: null,
            credentialPurpose: 'voice.client-auth',
          },
          links: {},
          fields: [],
        }),
      }],
    }).get(providerId);
    if (!descriptor) throw new Error('expected connected conversation descriptor');
    const token = Object.freeze({});
    onTestFinished(() => removeExternalVoiceProviderRegistration(token));
    commitExternalVoiceProviderRegistration({
      token,
      pluginId: 'acme.connected',
      localId: 'connected-conversation',
      providerId,
      descriptor,
      adapter: null,
    });
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const screen = await renderScreen(<BundledConversationSettingsSection
      voice={voiceSettingsParse({
        providerId,
        providers: {
          [providerId]: {
            schemaVersion: 1,
            config: OpenAiRealtimeSettingsV1Schema.parse({}),
          },
        },
      })}
      setVoice={vi.fn()}
    />);

    expect({
      sourceSelectors: screen.tree.findAllByType('VoiceCredentialSourceField' as any).length,
      savedSecretEditors: screen.tree.findAllByType('VoiceCredentialItem' as any).length,
    }).toEqual({ sourceSelectors: 1, savedSecretEditors: 0 });
  });

  it('routes an unresolved multi-source conversation SavedSecret edit through the atomic source owner', async () => {
    const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
    const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
    const base = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    if (base?.kind !== 'voice.conversation-provider.v1'
      || base.declaration?.kind !== 'conversation'
      || !base.declaration.credentials) {
      throw new Error('expected OpenAI conversation declaration');
    }
    const providerId = 'acme.multi/multi-conversation';
    const descriptor = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.multi',
        providerId,
        declaration: {
          ...base.declaration,
          id: 'multi-conversation',
        },
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.multi-conversation',
        selectionOptions: [{
          id: 'byo',
          modeId: 'byo',
          order: 10,
          titleKey: 'Multi-source conversation',
          subtitleKey: 'Multi-source conversation subtitle',
          configPatch: {},
        }],
        createSettingsSection: () => ({
          kind: 'voice.internal.realtime-settings.v1',
          providerId,
          mode: 'byo',
          credential: {
            kind: 'api_key',
            catalog: null,
            credentialPurpose: 'voice.client-auth',
          },
          links: {},
          fields: [],
        }),
      }],
    }).get(providerId);
    if (!descriptor) throw new Error('expected multi-source conversation descriptor');
    const token = Object.freeze({});
    onTestFinished(() => removeExternalVoiceProviderRegistration(token));
    commitExternalVoiceProviderRegistration({
      token,
      pluginId: 'acme.multi',
      localId: 'multi-conversation',
      providerId,
      descriptor,
      adapter: null,
    });
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const screen = await renderScreen(<BundledConversationSettingsSection
      voice={voiceSettingsParse({
        providerId,
        providers: {
          [providerId]: {
            schemaVersion: 1,
            config: OpenAiRealtimeSettingsV1Schema.parse({}),
          },
        },
      })}
      setVoice={vi.fn()}
    />);

    expect(screen.tree.findByType('VoiceCredentialItem' as any).props)
      .toMatchObject({
        credentialSlotId: 'api_key',
        credentialSourcePurpose: 'voice.client-auth',
      });
  });

  it('renders no realtime-provider error panel when the selected provider is off or local', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    for (const providerId of [null, 'local_conversation']) {
      const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, {
        voice: { providerId } as any,
        setVoice: vi.fn(),
      }));
      expect(screen.tree.findAllByType('ItemGroup' as any)).toHaveLength(0);
    }
  });

  it('reveals same-provider public settings actions when runtime registration arrives after render', async () => {
    removeExternalVoiceProviderRegistration(defaultRegistrationToken);
    publicSettingsRegistrationState.available = false;
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
        billingMode: 'byo', agentId: '',
        tts: { voiceId: 'voice', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, speed: null,
        } },
      } } },
    } as any;
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, {
      voice,
      setVoice: vi.fn(),
    }));
    await act(async () => undefined);
    expect(screen.tree.findAllByProps({ testID: 'voice-settings-action-create-agent' })).toHaveLength(0);

    const token = Object.freeze({});
    publicSettingsRegistrationState.available = true;
    await act(async () => {
      commitExternalVoiceProviderRegistration(Object.freeze({
        token,
        pluginId: 'happier.voice.elevenlabs',
        localId: 'realtime-elevenlabs',
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        descriptor: null,
        adapter: null,
        settingsActions: Object.freeze({
          async execute() {
            return Object.freeze({ patch: Object.freeze({}) });
          },
        }),
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      screen.tree.findAllByProps({ testID: 'voice-settings-action-create-agent' }).length,
    ).toBeGreaterThan(0));
    act(() => removeExternalVoiceProviderRegistration(token));
  });
  it('allows opening the voice dropdown even when API key is not set', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            agentId: '',
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null,
              voiceSettings: { stability: null, similarityBoost: null, speed: null },
            },
          },
        },
      },
    };

    let tree: ReturnType<typeof renderer.create> | undefined;
    tree = (await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice }))).tree;

    const dropdowns = tree!.findAllByType('DropdownMenu' as any);
    const voiceDropdown = dropdowns.find((d: any) => d.props?.search === true && d.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder');
    expect(voiceDropdown).toBeTruthy();

    expect(voiceDropdown!.props.itemTrigger).toBeTruthy();
    expect(voiceDropdown!.props.itemTrigger.detailFormatter?.(null)).toBe('settingsVoice.realtimeProviders.catalog.credentialRequired');
  });

  it('projects a retained credential awaiting recipient approval as review-required in provider summaries', async () => {
    credentialState.exists = true;
    credentialState.reviewRequired = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            agentId: '',
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi',
              modelId: null,
              voiceSettings: {
                stability: null,
                similarityBoost: null,
                speed: null,
              },
            },
          },
        },
      },
    };

    const screen = await renderScreen(React.createElement(
      BundledConversationSettingsSection,
      { voice, setVoice: vi.fn() },
    ));
    const voiceDropdown = screen.tree.findAllByType('DropdownMenu' as any).find(
      (dropdown: any) => dropdown.props?.search === true
        && dropdown.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder',
    );
    expect(voiceDropdown).toBeTruthy();
    expect(voiceDropdown!.props.itemTrigger.detailFormatter?.(null))
      .toBe('settingsVoice.externalCredentials.reviewRequired');
    expect(screen.tree.findByProps({
      testID: 'voice-settings-action-create-agent',
    }).props.disabled).toBe(false);
  });

  it('keeps credential deletion in the canonical credential item instead of rendering a competing disconnect action', async () => {
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo', agentId: '',
            tts: { voiceId: 'voice', modelId: null, voiceSettings: {
              stability: null, similarityBoost: null, speed: null,
            } },
          },
        },
      },
    };
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice: vi.fn() }));
    expect(screen.tree.findAllByProps({ title: 'settingsVoice.realtimeProviders.disconnect.title' })).toHaveLength(0);
    expect(screen.tree.findAllByType('VoiceCredentialItem' as any)).not.toHaveLength(0);
  });

  it('binds client BYOK to account SavedSecrets and requires plaintext-mode disclosure', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo', agentId: '',
            tts: { voiceId: 'voice', modelId: null, voiceSettings: {
              stability: null, similarityBoost: null, speed: null,
            } },
          },
        },
      },
    };
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice: vi.fn() }));
    const credential = screen.tree.findByType('VoiceCredentialItem' as any);
    const accountCredentialSlot = createDefaultVoiceProviderRegistry()
      .get('happier.voice.elevenlabs/realtime-elevenlabs')?.accountCredentialSlot;
    expect(accountCredentialSlot).toBeTruthy();
    expect(credential.props).toMatchObject({
      credentialSlotId: 'api_key',
      credentialSourcePurpose: 'voice.client-auth.signed-url',
      recipientContract: accountCredentialSlot?.recipientContract,
      recipientContractDigest: accountCredentialSlot?.recipientContractDigest,
      disclosePlainStorage: true,
    });
    expect(credential.props).not.toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
  });

  it('wires welcome message selection into settings', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo', agentId: '',
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null,
              voiceSettings: { stability: null, similarityBoost: null, speed: null },
            },
          },
        },
      },
    };

    let tree: ReturnType<typeof renderer.create> | undefined;
    tree = (await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice }))).tree;

    const dropdowns = tree!.findAllByType('DropdownMenu' as any);
    const welcomeDropdown = dropdowns.find((d: any) => Array.isArray(d.props?.items) && d.props.items.some((i: any) => i?.id === 'on_first_turn'));
    expect(welcomeDropdown).toBeTruthy();

    act(() => {
      welcomeDropdown!.props.onSelect?.('off');
    });

    expect(setVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        welcome: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('reports a bounded provisioning failure stage without persisting an unverified agent id', async () => {
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const { Modal } = await import('@/modal');

    bundledUiSpies.findExistingAgents.mockResolvedValue([{
      agentId: 'agent_existing',
      name: 'Happier Voice',
    }]);
    bundledUiSpies.updateAgent.mockRejectedValue(Object.assign(
      new Error('provider_response_invalid'),
      { code: 'provider_response_invalid', stage: 'update_tool' },
    ));

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            agentId: '',
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi',
              modelId: null,
              voiceSettings: {
                stability: null,
                similarityBoost: null,
                speed: null,
              },
            },
          },
        },
      },
    };
    const screen = await renderScreen(React.createElement(
      BundledConversationSettingsSection,
      { voice, setVoice },
    ));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(
      screen.tree,
      'Item' as any,
      { title: 'Create Happier Voice agent' },
    );
    if (!createItem) throw new Error('missing autoprovision action');

    await act(async () => {
      await pressTestInstanceAsync(createItem);
    });
    // The alert names the failing provisioning step so the press is
    // reportable. The stage token itself is passed as a copy parameter and is
    // asserted exactly in VoiceProviderSettingsActions.test.tsx; this mocked
    // text module renders keys without their parameters.
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.realtimeProviders.operationFailedUnsaved'
        + '\n\nsettingsVoice.realtimeProviders.operationFailedStage',
    ));

    expect(setVoice).not.toHaveBeenCalled();
  });

  it('keeps client-executed autoprovision independent of daemon selection changes', async () => {
    credentialState.exists = true;
    let resolveExisting!: (rows: Array<{ agentId: string; name: string }>) => void;
    bundledUiSpies.findExistingAgents.mockImplementationOnce(async () => await new Promise((resolve) => {
      resolveExisting = resolve;
    }));
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const baseConfig = {
      billingMode: 'byo', agentId: '',
      tts: { voiceId: 'voice', modelId: null, voiceSettings: {
        stability: null, similarityBoost: null, speed: null,
      } },
    };
    const render = (machineId: string) => React.createElement(BundledConversationSettingsSection, {
      voice: {
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        executionMachine: { kind: 'machine', machineId },
        providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: baseConfig } },
      } as any,
      setVoice: vi.fn(),
    });
    const screen = await renderScreen(render('machine_a'));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(screen.tree, 'Item' as any, { title: 'Create Happier Voice agent' });
    if (!createItem) throw new Error('missing autoprovision action');
    act(() => createItem.props.onPress());
    await vi.waitFor(() => expect(bundledUiSpies.findExistingAgents).toHaveBeenCalledTimes(1));
    await screen.update(render('machine_b'));
    await act(async () => resolveExisting([]));
    expect(bundledUiSpies.createAgent).toHaveBeenCalledTimes(1);
  });

  it('aborts a deferred autoprovision when its provider target retires without publishing stale work', async () => {
    credentialState.exists = true;
    let resolveExisting!: (rows: Array<{ agentId: string; name: string }>) => void;
    const operationSignals: AbortSignal[] = [];
    bundledUiSpies.findExistingAgents.mockImplementationOnce(async (signal: AbortSignal) => {
      operationSignals.push(signal);
      return await new Promise((resolve) => {
        resolveExisting = resolve;
      });
    });
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const setVoice = vi.fn();
    const activeVoice = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
        billingMode: 'byo', agentId: '',
        tts: { voiceId: 'voice', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, speed: null,
        } },
      } } },
    } as any;
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, {
      voice: activeVoice,
      setVoice,
    }));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(
      screen.tree,
      'Item' as any,
      { title: 'Create Happier Voice agent' },
    );
    if (!createItem) throw new Error('missing autoprovision action');
    act(() => createItem.props.onPress());
    await vi.waitFor(() => expect(operationSignals).toHaveLength(1));
    await screen.update(React.createElement(BundledConversationSettingsSection, {
      voice: { providerId: null } as any,
      setVoice,
    }));
    expect(operationSignals[0]?.aborted).toBe(true);
    await act(async () => resolveExisting([]));
    expect(bundledUiSpies.createAgent).not.toHaveBeenCalled();
    expect(bundledUiSpies.updateAgent).not.toHaveBeenCalled();
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('does not let a stale legacy-secret scrub overwrite newer canonical provider settings', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const setVoice = vi.fn();
    const legacyConfig = {
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
      tts: { voiceId: 'voice_old', modelId: null, voiceSettings: {
        stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
      } },
    };
    const initial: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 1, config: legacyConfig } },
    };
    const latest: any = {
      ...initial,
      providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
        billingMode: 'byo', agentId: 'agent_1',
        tts: {
          voiceId: 'voice_new',
          modelId: legacyConfig.tts.modelId,
          voiceSettings: { stability: null, similarityBoost: null, speed: null },
        },
      } } },
    };
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice: initial, setVoice }));
    const staleScrub = screen.tree.findByType('VoiceCredentialItem' as any).props.onCredentialAvailable;
    await screen.update(React.createElement(BundledConversationSettingsSection, { voice: latest, setVoice }));
    act(() => staleScrub?.());
    expect(setVoice.mock.calls.some((call) => call[0]?.providers?.['happier.voice.elevenlabs/realtime-elevenlabs']?.config?.tts?.voiceId === 'voice_old')).toBe(false);
  });

  it('merges a completed settings action into the latest canonical same-provider config', async () => {
    credentialState.exists = true;
    let resolveCreate!: (value: { agentId: string }) => void;
    bundledUiSpies.findExistingAgents.mockResolvedValueOnce([]);
    bundledUiSpies.createAgent.mockImplementationOnce(async () => await new Promise((resolve) => { resolveCreate = resolve; }));
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const base = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      executionMachine: { kind: 'machine', machineId: 'machine_a' },
      providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
            billingMode: 'byo', agentId: '',
        tts: { voiceId: 'voice_old', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, speed: null,
        } },
      } } },
    } as any;
    const setVoice = vi.fn();
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice: base, setVoice }));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(screen.tree, 'Item' as any, { title: 'Create Happier Voice agent' });
    if (!createItem) throw new Error('missing autoprovision action');
    act(() => createItem.props.onPress());
    await vi.waitFor(() => expect(bundledUiSpies.createAgent).toHaveBeenCalledTimes(1));
    const canonicalProviderId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    canonicalAccountSettings.voice = {
      ...canonicalAccountSettings.voice,
      providers: {
        ...canonicalAccountSettings.voice.providers,
        [canonicalProviderId]: {
          schemaVersion: 2,
          config: {
            ...canonicalAccountSettings.voice.providers[canonicalProviderId].config,
            tts: {
              ...canonicalAccountSettings.voice.providers[canonicalProviderId].config.tts,
              voiceId: 'voice_new',
            },
          },
        },
      },
    };
    await act(async () => resolveCreate({ agentId: 'agent_new' }));
    expect(canonicalAccountSettings.voice.providers[canonicalProviderId].config).toMatchObject({
      agentId: 'agent_new',
      tts: { voiceId: 'voice_new' },
    });
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('fails closed instead of treating secret-shaped canonical data as a legacy import source', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice: any = {
      providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
      providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': {
          schemaVersion: 2,
          config: {
            billingMode: 'byo',
            byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'must_not_import' } },
          },
        },
      },
    };

    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, {
      voice,
      setVoice: vi.fn(),
    }));

    expect(screen.tree.findAllByType('VoiceCredentialItem' as any)).toHaveLength(0);
    expect(screen.tree.findByProps({ title: 'settingsVoice.realtimeProviders.unavailable.rowTitle' })).toBeTruthy();
  });
});
