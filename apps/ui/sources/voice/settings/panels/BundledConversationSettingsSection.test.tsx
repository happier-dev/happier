import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import {
  ElevenLabsVoiceProviderSettingsSchema,
} from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const credentialState = vi.hoisted(() => ({ exists: false }));
const publicSettingsRegistrationState = vi.hoisted(() => ({ available: true }));
const bundledUiSpies = vi.hoisted(() => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  findExistingAgents: vi.fn(),
  listVoices: vi.fn(async () => []),
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
});

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
    if (providerId !== 'realtime_elevenlabs') return null;
    const contribution = {
    settingsDescriptor: {
      kind: 'voice.internal.conversation-settings.v1',
      providerId: 'realtime_elevenlabs',
      modes: ['happier', 'byo'],
      titleKey: 'settingsVoice.byo.title',
      footerKey: 'settingsVoice.byo.provisioningGroupFooter',
      credential: {
        kind: 'api_key', catalog: 'voices',
        titleKey: 'settingsVoice.byo.apiKeyTitle',
        promptTitleKey: 'settingsVoice.byo.apiKeyTitle',
        promptBodyKey: 'settingsVoice.byo.apiKeyDescription',
      },
      links: {},
      fields: [
        { kind: 'welcome', path: 'welcome', titleKey: 'settingsVoice.byo.realtime.call.welcome.title', subtitleKey: 'settingsVoice.byo.realtime.call.welcome.subtitle' },
        { kind: 'text', path: 'byo.agentId', titleKey: 'settingsVoice.byo.agentIdTitle', subtitleKey: 'settingsVoice.byo.agentIdDescription' },
        { kind: 'remote_voice', path: 'tts.voiceId', catalog: 'voices', titleKey: 'settingsVoice.byo.realtime.voicePicker.title', subtitleKey: 'settingsVoice.byo.realtime.voicePicker.subtitle', searchPlaceholderKey: 'settingsVoice.byo.voiceSearchPlaceholder' },
        { kind: 'select', path: 'tts.modelId', titleKey: 'settingsVoice.byo.realtime.modelPicker.title', subtitleKey: 'settingsVoice.byo.realtime.modelPicker.subtitle', options: [{ id: '', title: 'Auto' }] },
        { kind: 'autoprovision', path: 'byo.agentId', ttsPath: 'tts', titleKey: 'settingsVoice.byo.autoprovCreate', subtitleKey: 'settingsVoice.byo.autoprovCreateSubtitle' },
      ],
    },
    settingsOwner: {
      currentSchemaVersion: 2,
      defaultConfig: {
        mode: 'default',
        billingMode: 'byo',
        byo: { agentId: null },
        tts: {
          voiceId: 'EST9Ui6982FZPSi7gCHi',
          modelId: null,
          voiceSettings: { stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null },
        },
      },
      parseConfig: (value: unknown) => {
        const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
      readLegacySecret: (value: any) => value?.byo?.apiKey ?? null,
      migrateLegacy: (value: any) => {
        if (!value || typeof value !== 'object') return null;
        const { assistantLanguage: _assistantLanguage, welcome: _welcome, byo, ...rest } = value;
        return { config: { mode: 'default', ...rest, byo: { agentId: byo?.agentId ?? null } } };
      },
    },
    client: publicSettingsRegistrationState.available ? {
      listVoices: bundledUiSpies.listVoices,
    } : null,
    autoprovision: publicSettingsRegistrationState.available ? {
      createAgent: bundledUiSpies.createAgent,
      updateAgent: bundledUiSpies.updateAgent,
      findExistingAgents: bundledUiSpies.findExistingAgents,
    } : null,
    };
    return contribution;
  },
}));

vi.mock('@/voice/credentials/CredentialItem', () => ({
  VoiceCredentialItem: (props: any) => {
    React.useEffect(() => {
      props.onStatusChanged?.({ exists: credentialState.exists, protection: 'file_permissions' });
    }, [props.onStatusChanged]);
    return React.createElement('VoiceCredentialItem', props);
  },
}));

vi.mock('@/voice/settings/modals/showBundledVoiceAgentReuseDialog', () => ({
  showBundledVoiceAgentReuseDialog: vi.fn(),
}));

describe('BundledConversationSettingsSection', () => {
  beforeEach(() => {
    credentialState.exists = false;
    publicSettingsRegistrationState.available = true;
    bundledUiSpies.createAgent.mockReset();
    bundledUiSpies.updateAgent.mockReset();
    bundledUiSpies.findExistingAgents.mockReset();
    bundledUiSpies.listVoices.mockReset();
    bundledUiSpies.listVoices.mockResolvedValue([]);
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
    publicSettingsRegistrationState.available = false;
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice = {
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: {
        mode: 'default',
        billingMode: 'byo', byo: { agentId: null },
        tts: { voiceId: 'voice', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
        } },
      } } },
    } as any;
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, {
      voice,
      setVoice: vi.fn(),
    }));
    await act(async () => undefined);
    expect(screen.tree.findAllByProps({ testID: 'voice-realtime-autoprovision-create' })).toHaveLength(0);

    const token = Object.freeze({});
    publicSettingsRegistrationState.available = true;
    await act(async () => {
      commitExternalVoiceProviderRegistration(Object.freeze({
        token,
        pluginId: 'happier.voice.elevenlabs',
        localId: 'realtime-elevenlabs',
        providerId: 'realtime_elevenlabs',
        descriptor: null,
        adapter: null,
        settingsOperations: Object.freeze({
          async provision() {
            return Object.freeze({ updated: true });
          },
        }),
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      screen.tree.findAllByProps({ testID: 'voice-realtime-autoprovision-create' }).length,
    ).toBeGreaterThan(0));
    act(() => removeExternalVoiceProviderRegistration(token));
  });
  it('allows opening the voice dropdown even when API key is not set', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo',
            byo: { agentId: null },
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null,
              voiceSettings: { stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null },
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

  it('keeps credential deletion in the canonical credential item instead of rendering a competing disconnect action', async () => {
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo', byo: { agentId: null },
            tts: { voiceId: 'voice', modelId: null, voiceSettings: {
              stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
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
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo', byo: { agentId: null },
            tts: { voiceId: 'voice', modelId: null, voiceSettings: {
              stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
            } },
          },
        },
      },
    };
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice: vi.fn() }));
    const credential = screen.tree.findByType('VoiceCredentialItem' as any);
    const accountCredentialSlot = createDefaultVoiceProviderRegistry()
      .get('realtime_elevenlabs')?.accountCredentialSlot;
    expect(accountCredentialSlot).toBeTruthy();
    expect(credential.props).toMatchObject({
      providerId: 'realtime_elevenlabs',
      credentialSlotId: 'api_key',
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
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo', byo: { agentId: null },
            tts: {
              voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null,
              voiceSettings: { stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null },
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

  it('offers updating an existing Happier agent when it already exists', async () => {
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const { showBundledVoiceAgentReuseDialog } = await import('@/voice/settings/modals/showBundledVoiceAgentReuseDialog');

    bundledUiSpies.findExistingAgents.mockResolvedValue([{ agentId: 'agent_existing', name: 'Happier Voice' }]);
    (showBundledVoiceAgentReuseDialog as any).mockResolvedValue('update_existing');
    bundledUiSpies.updateAgent.mockResolvedValue(undefined);

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo', byo: { agentId: null },
            tts: { voiceId: 'EST9Ui6982FZPSi7gCHi', modelId: null,
              voiceSettings: { stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null } },
          },
        },
      },
    };

    let tree: ReturnType<typeof renderer.create> | undefined;
    tree = (await renderScreen(React.createElement(BundledConversationSettingsSection, { voice, setVoice }))).tree;
    await act(async () => undefined);

    const createItem = findTestInstanceByTypeWithProps(tree!, 'Item' as any, { title: 'settingsVoice.byo.autoprovCreate' });
    expect(createItem).toBeTruthy();
    expect(createItem!.props.disabled).toBe(false);

    await act(async () => {
      await pressTestInstanceAsync(createItem!);
    });
    await vi.waitFor(() => expect(bundledUiSpies.updateAgent).toHaveBeenCalled());

    expect(bundledUiSpies.createAgent).not.toHaveBeenCalled();
    expect(bundledUiSpies.updateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_existing' }),
      expect.any(AbortSignal),
    );
    expect(bundledUiSpies.updateAgent.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(setVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          realtime_elevenlabs: expect.objectContaining({
            config: expect.objectContaining({ byo: expect.objectContaining({ agentId: 'agent_existing' }) }),
          }),
        }),
      }),
    );
  });

  it('reports a bounded provisioning failure stage without persisting an unverified agent id', async () => {
    credentialState.exists = true;
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const { showBundledVoiceAgentReuseDialog } = await import('@/voice/settings/modals/showBundledVoiceAgentReuseDialog');
    const { Modal } = await import('@/modal');

    bundledUiSpies.findExistingAgents.mockResolvedValue([{
      agentId: 'agent_existing',
      name: 'Happier Voice',
    }]);
    (showBundledVoiceAgentReuseDialog as any).mockResolvedValue('update_existing');
    bundledUiSpies.updateAgent.mockRejectedValue(Object.assign(
      new Error('provider_response_invalid'),
      { code: 'provider_response_invalid', stage: 'update_tool' },
    ));

    const setVoice = vi.fn();
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 2,
          config: {
            mode: 'default',
            billingMode: 'byo',
            byo: { agentId: null },
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
      { title: 'settingsVoice.byo.autoprovCreate' },
    );
    if (!createItem) throw new Error('missing autoprovision action');

    await act(async () => {
      await pressTestInstanceAsync(createItem);
    });
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith(
      'common.error',
      'settingsVoice.byo.autoprovFailed\n\n[update_tool]',
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
      mode: 'default',
      billingMode: 'byo', byo: { agentId: null },
      tts: { voiceId: 'voice', modelId: null, voiceSettings: {
        stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
      } },
    };
    const render = (machineId: string) => React.createElement(BundledConversationSettingsSection, {
      voice: {
        providerId: 'realtime_elevenlabs',
        executionMachine: { kind: 'machine', machineId },
        providers: { realtime_elevenlabs: { schemaVersion: 2, config: baseConfig } },
      } as any,
      setVoice: vi.fn(),
    });
    const screen = await renderScreen(render('machine_a'));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(screen.tree, 'Item' as any, { title: 'settingsVoice.byo.autoprovCreate' });
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
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: {
        mode: 'default',
        billingMode: 'byo', byo: { agentId: null },
        tts: { voiceId: 'voice', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
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
      { title: 'settingsVoice.byo.autoprovCreate' },
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
      providerId: 'realtime_elevenlabs',
      providers: { realtime_elevenlabs: { schemaVersion: 1, config: legacyConfig } },
    };
    const latest: any = {
      ...initial,
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: {
        mode: 'default',
        billingMode: 'byo', byo: { agentId: 'agent_1' },
        tts: { ...legacyConfig.tts, voiceId: 'voice_new' },
      } } },
    };
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice: initial, setVoice }));
    const staleScrub = screen.tree.findByType('VoiceCredentialItem' as any).props.onCredentialAvailable;
    await screen.update(React.createElement(BundledConversationSettingsSection, { voice: latest, setVoice }));
    act(() => staleScrub?.());
    expect(setVoice.mock.calls.some((call) => call[0]?.providers?.realtime_elevenlabs?.config?.tts?.voiceId === 'voice_old')).toBe(false);
  });

  it('merges a completed autoprovision result into the latest same-provider config', async () => {
    credentialState.exists = true;
    let resolveCreate!: (value: { agentId: string }) => void;
    bundledUiSpies.findExistingAgents.mockResolvedValueOnce([]);
    bundledUiSpies.createAgent.mockImplementationOnce(async () => await new Promise((resolve) => { resolveCreate = resolve; }));
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const base = {
      providerId: 'realtime_elevenlabs',
      executionMachine: { kind: 'machine', machineId: 'machine_a' },
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: {
        mode: 'default',
        billingMode: 'byo', byo: { agentId: null },
        tts: { voiceId: 'voice_old', modelId: null, voiceSettings: {
          stability: null, similarityBoost: null, style: null, useSpeakerBoost: null, speed: null,
        } },
      } } },
    } as any;
    const setVoice = vi.fn();
    const screen = await renderScreen(React.createElement(BundledConversationSettingsSection, { voice: base, setVoice }));
    await act(async () => undefined);
    const createItem = findTestInstanceByTypeWithProps(screen.tree, 'Item' as any, { title: 'settingsVoice.byo.autoprovCreate' });
    if (!createItem) throw new Error('missing autoprovision action');
    act(() => createItem.props.onPress());
    await vi.waitFor(() => expect(bundledUiSpies.createAgent).toHaveBeenCalledTimes(1));
    const latest = {
      ...base,
      providers: { realtime_elevenlabs: { schemaVersion: 2, config: {
        ...base.providers.realtime_elevenlabs.config,
        tts: { ...base.providers.realtime_elevenlabs.config.tts, voiceId: 'voice_new' },
      } } },
    };
    await screen.update(React.createElement(BundledConversationSettingsSection, { voice: latest, setVoice }));
    await act(async () => resolveCreate({ agentId: 'agent_new' }));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ realtime_elevenlabs: expect.objectContaining({
        config: expect.objectContaining({
          byo: { agentId: 'agent_new' },
          tts: expect.objectContaining({ voiceId: 'voice_new' }),
        }),
      }) }),
    }));
  });

  it('fails closed instead of treating secret-shaped canonical data as a legacy import source', async () => {
    const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
    const voice: any = {
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
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
