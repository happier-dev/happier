import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit';
import { t } from '@/text';


(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
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

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    isAgentId: (v: any) => v === 'codex' || v === 'claude',
    getAgentCore: (id: string) => ({
      displayNameKey: 'common.ok' as any,
      ui: { agentPickerIconName: 'sparkles-outline' },
      model: { supportsSelection: true, supportsFreeform: true, allowedModes: ['m1', 'm2'], defaultMode: 'default' },
    }),
  };
});

vi.mock('@/sync/domains/models/modelOptions', () => ({
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
    useSettings: () => ({}),
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

type LocalConversationAdapter = VoiceSettings['adapters']['local_conversation'];

type LocalConversationAdapterOverrides = Partial<Omit<LocalConversationAdapter, 'agent'>> & {
  agent?: Partial<LocalConversationAdapter['agent']>;
};

function withProvider(voice: VoiceSettings, providerId: VoiceSettings['providerId']): VoiceSettings {
  return { ...voice, providerId };
}

function createLocalConversationVoice(overrides: LocalConversationAdapterOverrides = {}): VoiceSettings {
  const defaults = voiceSettingsDefaults.adapters.local_conversation;
  return {
    ...voiceSettingsDefaults,
    providerId: 'local_conversation',
    adapters: {
      ...voiceSettingsDefaults.adapters,
      local_conversation: {
        ...defaults,
        ...overrides,
        agent: {
          ...defaults.agent,
          ...overrides.agent,
        },
      },
    },
  };
}

function findDropdownByItemTriggerTitle(
  screen: Pick<SettingsViewHarness, 'findAll'>,
  title: string,
) {
  return screen.findAll((node) => String(node.type) === 'DropdownMenu' && node.props?.itemTrigger?.title === title)[0] ?? null;
}

beforeEach(() => {
  featureEnabledState['voice.agent'] = true;
  settingsState.current.recentMachinePaths = [{ machineId: 'machine-1', path: '/tmp/repo' }];
  preflightModelsCallSpy.mockClear();
});

async function loadLocalConversationSection() {
  const mod = await import('@/voice/settings/panels/LocalConversationSection');
  return mod.LocalConversationSection;
}

describe('LocalConversationSection', () => {
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

  it('renders a backend dropdown for the voice agent when agentSource=agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'daemon',
        agentSource: 'agent',
        agentId: 'codex',
        chatModelSource: 'custom',
        chatModelId: 'm1',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const backendDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorBackend'));
    expect(backendDropdown?.props.selectedId).toBe('daemon');
  });

  it('renders a chat model dropdown for the voice agent when chatModelSource=custom', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'daemon',
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
        backend: 'daemon',
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
        backend: 'daemon',
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
        backend: 'daemon',
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

  it('uses the fixed voice agent machine id when preflighting models', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'daemon',
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
        backend: 'daemon',
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

  it('renders a machine dropdown for the voice agent runtime (auto + machines)', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'daemon',
        agentSource: 'agent',
        agentId: 'codex',
        machineTargetMode: 'auto',
        machineTargetId: null,
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const machineDropdown = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.agentMachine.title'));
    expect(machineDropdown?.props.selectedId).toBe('auto');
  });

  it('renders directory policy controls for the voice agent (stayInVoiceHome + teleport)', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        stayInVoiceHome: true,
        teleportEnabled: false,
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);

    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.agentMachine.stayInVoiceHomeTitle'))).toBeTruthy();
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.agentMachine.allowTeleportTitle'))).toBeTruthy();
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

  it('disables the daemon mediator backend option when voice.agent is disabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    featureEnabledState['voice.agent'] = false;
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'openai_compat',
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const mediatorBackend = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorBackend'));
    if (!mediatorBackend) throw new Error('Expected mediator backend dropdown to be rendered');
    const daemonItem = (mediatorBackend.props.items ?? []).find((it: any) => it?.id === 'daemon');
    expect(daemonItem?.disabled).toBe(true);
  });

  it('keeps the daemon mediator backend option enabled when voice.agent is enabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        backend: 'openai_compat',
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const mediatorBackend = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorBackend'));
    if (!mediatorBackend) throw new Error('Expected mediator backend dropdown to be rendered');
    const daemonItem = (mediatorBackend.props.items ?? []).find((it: any) => it?.id === 'daemon');
    expect(daemonItem?.disabled).not.toBe(true);
  });
});
