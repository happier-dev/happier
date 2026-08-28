import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceLocalConversationSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit';
import { t } from '@/text';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';


(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const platformOsMock = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));
const daemonProjectionState = vi.hoisted((): { current: any } => ({
  current: {
    phase: 'ready' as const,
    inputs: {
      mergedProviderProjectionById: {
        'com.acme.voice.agent': {
          agentId: 'com.acme.voice.agent',
          qualifiedId: 'com.acme.voice.agent',
          identity: { pluginId: 'com.acme.voice', localId: 'agent' },
          installedPackage: null,
          projectionGeneration: 7,
          title: 'Acme Voice',
          subtitle: 'External conversation Agent',
          channel: 'plugin' as const,
          isBuiltIn: false,
          settingsBackendId: null,
          catalogAgentId: null,
          iconAgentId: null,
          cli: null,
          connectedAccounts: null,
          ui: null,
        },
      },
      mergedBackendProjectionById: {},
      discoveredBackendIds: [],
      pluginProjectionById: {},
      pluginProjectionV2: null,
      registryDiagnostics: [],
    },
  },
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
      select: <T,>(options: { web?: T; default?: T; native?: T; ios?: T; android?: T }) =>
        options?.[platformOsMock.value] ?? options?.default ?? options?.native ?? options?.ios ?? options?.android,
    },
  });
});
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        textSecondary: '#666',
      },
    },
    });
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : null,
    ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['codex', 'claude'],
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => daemonProjectionState.current,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    isBundledAgentId: (v: any) => v === 'codex' || v === 'claude',
    getAgentCore: (id: string) => ({
      displayNameKey: 'common.ok' as any,
      ui: { agentPickerIconName: 'sparkles-outline' },
      model: { supportsSelection: true, supportsFreeform: true, allowedModes: ['m1', 'm2'], defaultMode: 'default' },
    }),
  };
});

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
  getModelOptionsForAgentType: () => [
    { value: 'default', label: 'Default', description: '' },
    { value: 'm1', label: 'Model 1', description: 'Fast' },
  ],
}));

const settingsState: { current: { recentMachinePaths: any[] } } = {
  current: { recentMachinePaths: [{ machineId: 'machine-1', path: '/tmp/repo' }] },
};
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSettings: () => settingsParse({}),
    useSetting: (key: string) => {
      if (key === 'recentMachinePaths') return settingsState.current.recentMachinePaths;
      return null;
    },
});
});

const preflightModelsCallSpy = vi.fn();
vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
  useNewSessionPreflightModelsState: (args: any) => {
    preflightModelsCallSpy(args);
    return {
    preflightModels: {
      availableModels: [{ id: 'codex-dynamic-1', name: 'Codex Dynamic 1', description: 'Dynamic list' }],
      supportsFreeform: true,
    },
    modelOptions: [
      { value: 'default', label: 'Default', description: '' },
      { value: 'm1', label: 'Model 1', description: 'Fast' },
      { value: 'codex-dynamic-1', label: 'Codex Dynamic 1', description: 'Dynamic list' },
    ],
    probe: { phase: 'idle', refreshedAt: 1, refresh: () => {} },
    };
  },
}));

vi.mock('@/voice/settings/panels/localStt/LocalVoiceSttGroup', () => ({
  LocalVoiceSttGroup: () => null,
}));
vi.mock('@/voice/settings/panels/localTts/LocalVoiceTtsGroup', () => ({
  LocalVoiceTtsGroup: () => null,
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canAgentResume: () => true,
}));
vi.mock('@/voice/agent/resetGlobalVoiceAgentPersistence', () => ({
  resetGlobalVoiceAgentPersistence: vi.fn(),
}));

vi.mock('@/sync/store/hooks', () => ({
  useAllMachines: () => [
    { id: 'machine-1', active: true, createdAt: 1, updatedAt: 1, activeAt: 1, seq: 1, metadata: { host: 'm1', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 },
    { id: 'machine-2', active: false, createdAt: 2, updatedAt: 2, activeAt: 2, seq: 1, metadata: { host: 'm2', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 },
  ],
  useLocalSetting: () => 1,
}));

const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

type LocalConversationAgentOverrides = Partial<VoiceLocalConversationSettings['agent']> & {
  machineTargetMode?: 'auto' | 'fixed';
  machineTargetId?: string | null;
  autoTargetMachineId?: string | null;
  welcome?: Partial<VoiceSettings['welcome']>;
};

type LocalConversationAdapterOverrides = Partial<Omit<VoiceLocalConversationSettings, 'agent'>> & {
  agent?: LocalConversationAgentOverrides;
};

function withProvider(voice: VoiceSettings, providerId: VoiceSettings['providerId']): VoiceSettings {
  return { ...voice, providerId };
}

function createLocalConversationVoice(overrides: LocalConversationAdapterOverrides = {}): VoiceSettings {
  const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  const next = writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
    ...defaults,
    ...overrides,
    agent: {
      ...defaults.agent,
      ...overrides.agent,
    },
  });
  return {
    ...next,
    providerId: 'local_conversation',
    executionMachine: {
      mode: overrides.agent?.machineTargetMode === 'fixed' ? 'fixed' : 'auto',
      machineId: overrides.agent?.machineTargetId ?? null,
      autoMachineId: overrides.agent?.autoTargetMachineId ?? null,
    },
    welcome: overrides.agent?.welcome
      ? { ...voiceSettingsDefaults.welcome, ...overrides.agent.welcome }
      : voiceSettingsDefaults.welcome,
  };
}

function findDropdownByItemTriggerTitle(
  screen: Pick<SettingsViewHarness, 'findAll'>,
  title: string,
) {
  return screen.findAll((node) => String(node.type) === 'DropdownMenu' && node.props?.itemTrigger?.title === title)[0] ?? null;
}

beforeEach(() => {
  platformOsMock.value = 'ios';
  featureEnabledState['voice.agent'] = true;
  daemonProjectionState.current.phase = 'ready';
  settingsState.current.recentMachinePaths = [{ machineId: 'machine-1', path: '/tmp/repo' }];
  preflightModelsCallSpy.mockClear();
});

async function loadLocalConversationSection() {
  const mod = await import('@/voice/settings/panels/LocalConversationSection');
  return mod.LocalConversationSection;
}

describe('LocalConversationSection', () => {
  it('offers the current machine external Agent with its exact projected identity', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const agentPicker = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.mediatorAgentId'),
    );
    const externalEntry = agentPicker?.props.items.find(
      (item: any) => item.id === 'com.acme.voice.agent',
    );

    expect(externalEntry).toMatchObject({
      id: 'com.acme.voice.agent',
      title: 'Acme Voice',
      subtitle: 'External conversation Agent',
    });
    expect(externalEntry.icon.props.entry).toMatchObject({
      qualifiedId: 'com.acme.voice.agent',
      identity: { pluginId: 'com.acme.voice', localId: 'agent' },
      projectionGeneration: 7,
      isBuiltIn: false,
    });

    // The exact target facts ride the catalog entry: no raw-id escape exists.
    expect(agentPicker?.props.items.map((item: any) => item.id)).not.toContain('__custom__');

    act(() => {
      agentPicker?.props.onSelect('com.acme.voice.agent');
    });

    const nextVoice = setVoice.mock.calls[0]?.[0] as VoiceSettings;
    expect(readLocalConversationVoiceSettings(nextVoice).agent.agentId).toBe('com.acme.voice.agent');
    expect(readLocalConversationVoiceSettings(nextVoice).agent).toMatchObject({
      agentTargetKey: 'agent:com.acme.voice/agent',
      agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
      agentProjectionGeneration: 7,
    });
  });

  it('persists the exact backend target key of a bundled Agent selection', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const agentPicker = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.mediatorAgentId'),
    );

    act(() => {
      agentPicker?.props.onSelect('codex');
    });

    const nextVoice = setVoice.mock.calls[0]?.[0] as VoiceSettings;
    expect(readLocalConversationVoiceSettings(nextVoice).agent).toMatchObject({
      agentId: 'codex',
      agentTargetKey: 'backend:codex',
      agentIdentity: null,
    });
  });

  it('does not offer an external Agent from a retained non-current projection', async () => {
    daemonProjectionState.current.phase = 'loading';
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: { agentSource: 'agent' },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const agentPicker = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.mediatorAgentId'),
    );

    expect(agentPicker?.props.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'com.acme.voice.agent' }),
    ]));
  });

  it('does not expose the retired Voice-owned Chat endpoint or credential controls', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    expect(screen.findAll((node) => String(node.type) === 'Item' && node.props?.title === t('settingsVoice.local.chatBaseUrl'))).toHaveLength(0);
    expect(screen.findAll((node) => String(node.type) === 'Item' && node.props?.title === t('settingsVoice.local.chatApiKey'))).toHaveLength(0);
  });

  it('asks once for the compatible Agent and commits both Provider tuples together', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        providerChat: {
          status: 'needs_selection',
          providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
          chatModelId: 'qwen-chat',
          commitModelId: 'qwen-commit',
          configuration: { temperature: 0.25 },
        },
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const prompts = screen.findAll((node) => (
      String(node.type) === 'DropdownMenu'
      && node.props?.itemTrigger?.title === t('settingsVoice.local.mediatorAgentId')
      && node.props?.selectedId === ''
    ));
    expect(prompts).toHaveLength(1);

    act(() => {
      prompts[0]!.props.onSelect('opencode');
    });

    const nextVoice = setVoice.mock.calls[0]?.[0] as VoiceSettings;
    expect(readLocalConversationVoiceSettings(nextVoice).agent).toMatchObject({
      agentSource: 'agent',
      agentId: 'opencode',
      providerChat: {
        status: 'configured',
        chat: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: 'voice-openai-compatible-chat',
          modelId: 'qwen-chat',
        },
        commit: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: 'voice-openai-compatible-chat',
          modelId: 'qwen-commit',
        },
      },
    });
    act(() => {
      screen.tree.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />);
    });
    expect(screen.findAll((node) => (
      String(node.type) === 'DropdownMenu'
      && node.props?.itemTrigger?.title === t('settingsVoice.local.mediatorAgentId')
      && node.props?.selectedId === ''
    ))).toHaveLength(0);
  });

  it('hides competing Agent and model selectors for configured Provider Chat while retaining shared controls', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'opencode',
        chatModelSource: 'custom',
        chatModelId: 'ignored-chat-model',
        commitModelSource: 'custom',
        commitModelId: 'ignored-commit-model',
        providerChat: {
          status: 'configured',
          chat: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
            modelId: 'provider-chat-model',
          },
          commit: {
            agentTargetKey: 'backend:opencode',
            providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
            modelId: 'provider-commit-model',
          },
          configuration: { temperature: 0.73 },
        },
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    for (const title of [
      t('settingsVoice.local.mediatorAgentSource'),
      t('settingsVoice.local.mediatorAgentId'),
      t('settingsVoice.local.mediatorChatModelSource'),
      t('settingsVoice.local.conversation.chatModelId.title'),
      t('settingsVoice.local.mediatorCommitModelSource'),
      t('settingsVoice.local.conversation.commitModelId.title'),
    ]) {
      expect(findDropdownByItemTriggerTitle(screen, title)).toBeNull();
    }

    expect(findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.mediatorPermissionPolicy'),
    )).not.toBeNull();
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeTruthy();
    expect(screen.findRowByTitle(t('settingsVoice.local.mediatorIdleTtl'))).toBeTruthy();
    expect(preflightModelsCallSpy).toHaveBeenLastCalledWith(expect.objectContaining({ backendTarget: null }));
  });

  it('offers the default session Agent model catalog while following the current session', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'session',
        chatModelSource: 'custom',
        commitModelSource: 'custom',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const chatModel = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.conversation.chatModelId.title'),
    );

    expect(chatModel?.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1' }),
      expect.objectContaining({ id: '__custom__' }),
    ]));
  });

  it('does not crash when providerId toggles away from local_conversation', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = () => {};
    const initialVoice = createLocalConversationVoice();
    const nextVoice = withProvider(voiceSettingsDefaults, 'off');

    const screen = await renderSettingsView(<LocalConversationSection voice={initialVoice} setVoice={setVoice} />);

    expect(() => {
      act(() => {
        screen.tree.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />);
      });
    }).not.toThrow();
  });

  it('renders the local section on web only when local remains the stored provider', async () => {
    platformOsMock.value = 'web';
    const LocalConversationSection = await loadLocalConversationSection();
    const localVoice = createLocalConversationVoice();

    const screen = await renderSettingsView(<LocalConversationSection voice={localVoice} setVoice={() => {}} />);

    expect(findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversationMode'))).toBeTruthy();

    act(() => {
      screen.tree.update(
        <LocalConversationSection
          voice={withProvider(localVoice, 'happier.voice.elevenlabs/realtime-elevenlabs')}
          setVoice={() => {}}
        />,
      );
    });

    expect(findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversationMode'))).toBeFalsy();
  });

  it('renders the fixed Agent dropdown when agentSource=agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'custom',
        chatModelId: 'm1',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const backendDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorBackend'));
    expect(backendDropdown?.props.selectedId).toBe('codex');
  });

  it('renders a chat model dropdown for the voice agent when chatModelSource=custom', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'custom',
        chatModelId: 'm1',
        commitModelSource: 'session',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const modelDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.chatModelId.title'));
    expect(modelDropdown?.props.selectedId).toBe('m1');
  });

  it('wraps chat model dropdown icons instead of exposing raw icon nodes to item rows', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'custom',
        chatModelId: 'm1',
        commitModelSource: 'session',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const modelDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.chatModelId.title'));
    if (!modelDropdown) throw new Error('Expected voice agent chat model dropdown to be rendered');

    const iconTypesById = Object.fromEntries(
      (modelDropdown.props.items ?? [])
        .filter((item: any) => ['__refresh_models__', 'm1', '__custom__'].includes(String(item?.id)))
        .map((item: any) => [String(item.id), item?.icon?.type ?? null]),
    );

    expect(Object.values(iconTypesById)).not.toContain('Ionicons');
  });

  it('renders a commit model dropdown for the voice agent when commitModelSource=custom', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'session',
        commitModelSource: 'custom',
        commitModelId: 'm1',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const modelDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.commitModelId.title'));
    expect(modelDropdown?.props.selectedId).toBe('m1');
  });

  it('surfaces dynamic preflight models for the selected backend in the chat model dropdown', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'custom',
        chatModelId: 'codex-dynamic-1',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const modelDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.chatModelId.title'));
    expect(modelDropdown?.props.selectedId).toBe('codex-dynamic-1');
  });

  it('preflights models against an externally installed Agent rather than the default Agent', async () => {
    // A configured voice Agent may legitimately be an installed non-bundled Agent. Narrowing the
    // selection to the bundled ids made the model preflight fall back to the default Agent, so the
    // dropdown offered another Agent's model catalog for it.
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'acme-agent',
        machineTargetMode: 'fixed',
        machineTargetId: 'machine-1',
        chatModelSource: 'custom',
      },
    });

    await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);

    expect(preflightModelsCallSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'acme-agent' },
      // Without naming the Agent, the preflight resolves a non-bundled backend id to
      // no Agent at all and probes nothing.
      runtimeCarrierAgentId: 'acme-agent',
    }));
  });

  it('uses the fixed voice agent machine id when preflighting models', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        machineTargetMode: 'fixed',
        machineTargetId: 'machine-1',
        chatModelSource: 'custom',
        chatModelId: 'codex-dynamic-1',
      },
    });

    await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);

    expect(preflightModelsCallSpy).toHaveBeenCalledWith(expect.objectContaining({ selectedMachineId: 'machine-1' }));
  });

  it('uses the resolved auto machine id when preflighting models', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        machineTargetMode: 'auto',
        machineTargetId: null,
        chatModelSource: 'custom',
        chatModelId: 'codex-dynamic-1',
      },
    });

    await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);

    expect(preflightModelsCallSpy).toHaveBeenCalledWith(expect.objectContaining({ selectedMachineId: 'machine-1' }));
  });

  it('does not render a second agent-only execution-machine owner', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
        machineTargetMode: 'auto',
        machineTargetId: null,
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const machineDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.agentMachine.title'));
    expect(machineDropdown).toBeFalsy();
  });

  it('names every rendered switch and isolates actionable row controls from row activation', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      stt: {
        ...defaults.stt,
        provider: 'device',
      },
      agent: {
        resumabilityMode: 'provider_resume',
        transcript: {
          ...defaults.agent.transcript,
          persistenceMode: 'persistent',
        },
        stayInVoiceHome: true,
        teleportEnabled: false,
        commitIsolation: true,
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const switchTitles = [
      t('settingsVoice.local.conversation.handsFree.enableTitle'),
      t('settingsVoice.local.conversation.providerResumeFallback.title'),
      t('settingsVoice.local.conversation.prewarm.title'),
      t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle'),
      t('settingsVoice.local.conversation.agentMachine.allowTeleportTitle'),
      t('settingsVoice.local.conversation.commitIsolation.title'),
      t('settingsVoice.local.conversation.streaming.enableTitle'),
      t('settingsVoice.local.conversation.streaming.enableTtsTitle'),
    ];

    for (const title of switchTitles) {
      const row = screen.findRowByTitle(title);
      if (!row) throw new Error(`Expected switch row "${title}"`);
      expect(row.props.rightElement?.props?.accessibilityLabel).toBe(title);
    }

    const actionableTitles = [
      t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle'),
      t('settingsVoice.local.conversation.agentMachine.allowTeleportTitle'),
      t('settingsVoice.local.conversation.commitIsolation.title'),
    ];
    for (const title of actionableTitles) {
      const row = screen.findRowByTitle(title);
      if (!row) throw new Error(`Expected actionable switch row "${title}"`);
      expect(row.props.rightElementOutsidePressable).toBe(true);

      setVoice.mockClear();
      act(() => row.props.onPress());
      expect(setVoice).toHaveBeenCalledTimes(1);

      setVoice.mockClear();
      act(() => row.props.rightElement.props.onValueChange(
        !row.props.rightElement.props.value,
      ));
      expect(setVoice).toHaveBeenCalledTimes(1);
    }
  });

  it('renders warm-root policy controls for the voice agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        rootSessionPolicy: 'keep_warm',
        maxWarmRoots: 4,
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const policyDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.rootSessionPolicy.title'));
    expect(policyDropdown?.props.selectedId).toBe('keep_warm');
  });

  it('hides Agent-only commit isolation when voice.agent is disabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    featureEnabledState['voice.agent'] = false;
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeFalsy();
  });

  it('shows Agent-only commit isolation when voice.agent is enabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeTruthy();
  });
});
