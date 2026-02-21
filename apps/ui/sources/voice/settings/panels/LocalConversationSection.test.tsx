import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

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
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      colors: {
        textSecondary: '#666',
      },
    },
  }),
  StyleSheet: {
    create: (styles: any) => styles,
    absoluteFillObject: {},
  },
}));

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
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useSetting: (key: string) => {
      if (key === 'recentMachinePaths') return settingsState.current.recentMachinePaths;
      return null;
    },
  };
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

function withProvider(voice: VoiceSettings, providerId: VoiceSettings['providerId']): VoiceSettings {
  return { ...voice, providerId };
}

async function loadLocalConversationSection() {
  // Ensure per-file mocks apply even when another test file imported the module earlier in the same worker.
  vi.resetModules();
  const mod = await import('@/voice/settings/panels/LocalConversationSection');
  return mod.LocalConversationSection;
}

describe('LocalConversationSection', () => {
  it('does not crash when providerId toggles away from local_conversation', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = () => {};
    const initialVoice = withProvider(voiceSettingsDefaults, 'local_conversation');
    const nextVoice = withProvider(voiceSettingsDefaults, 'off');

    let tree: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={initialVoice} setVoice={setVoice} />);
    });

    expect(() => {
      act(() => {
        tree.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />);
      });
    }).not.toThrow();
  });

  it('renders a backend dropdown for the voice agent when agentSource=agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            chatModelSource: 'custom',
            chatModelId: 'm1',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const backendDropdown = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'codex'));
    if (!backendDropdown) throw new Error('Expected voice agent backend dropdown to be rendered');
    expect(backendDropdown.props.selectedId).toBe('codex');
  });

  it('renders a chat model dropdown for the voice agent when chatModelSource=custom', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            chatModelSource: 'custom',
            chatModelId: 'm1',
            commitModelSource: 'session',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const modelDropdown = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'm1'));
    if (!modelDropdown) throw new Error('Expected voice agent chat model dropdown to be rendered');
    expect(modelDropdown.props.selectedId).toBe('m1');
  });

  it('renders a commit model dropdown for the voice agent when commitModelSource=custom', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            chatModelSource: 'session',
            commitModelSource: 'custom',
            commitModelId: 'm1',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const modelDropdown = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'm1'));
    if (!modelDropdown) throw new Error('Expected voice agent commit model dropdown to be rendered');
    expect(modelDropdown.props.selectedId).toBe('m1');
  });

  it('surfaces dynamic preflight models for the selected backend in the chat model dropdown', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            chatModelSource: 'custom',
            chatModelId: 'codex-dynamic-1',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const modelDropdown = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'codex-dynamic-1'));
    if (!modelDropdown) throw new Error('Expected dynamic preflight model to be available in the chat model dropdown');
    expect(modelDropdown.props.selectedId).toBe('codex-dynamic-1');
  });

  it('uses the fixed voice agent machine id when preflighting models', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    preflightModelsCallSpy.mockClear();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            machineTargetMode: 'fixed',
            machineTargetId: 'machine-1',
            chatModelSource: 'custom',
            chatModelId: 'codex-dynamic-1',
          },
        },
      },
    };

    act(() => {
      renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    expect(preflightModelsCallSpy).toHaveBeenCalledWith(expect.objectContaining({ selectedMachineId: 'machine-1' }));
  });

  it('uses the resolved auto machine id when preflighting models', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    preflightModelsCallSpy.mockClear();
    settingsState.current.recentMachinePaths = [{ machineId: 'machine-1', path: '/tmp/repo' }];

    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            machineTargetMode: 'auto',
            machineTargetId: null,
            chatModelSource: 'custom',
            chatModelId: 'codex-dynamic-1',
          },
        },
      },
    };

    act(() => {
      renderer.create(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    });

    expect(preflightModelsCallSpy).toHaveBeenCalledWith(expect.objectContaining({ selectedMachineId: 'machine-1' }));
  });

  it('renders a machine dropdown for the voice agent runtime (auto + machines)', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'daemon',
            agentSource: 'agent',
            agentId: 'codex',
            machineTargetMode: 'auto',
            machineTargetId: null,
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const machineDropdown = dropdowns.find((d: any) => {
      const items = d.props.items ?? [];
      if (!Array.isArray(items)) return false;
      const ids = items.map((it: any) => it?.id);
      return ids.includes('auto') && ids.includes('machine-1');
    });
    if (!machineDropdown) throw new Error('Expected machine dropdown to be rendered');
    expect(machineDropdown.props.selectedId).toBe('auto');
  });

  it('renders directory policy controls for the voice agent (stayInVoiceHome + teleport)', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            stayInVoiceHome: true,
            teleportEnabled: false,
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    });
    const items = tree.root.findAllByType('Item' as any);

    const stayItem = items.find((n: any) => n.props?.title === 'Stay in voice home');
    expect(stayItem).toBeTruthy();

    const teleportItem = items.find((n: any) => n.props?.title === 'Allow teleport');
    expect(teleportItem).toBeTruthy();
  });

  it('renders warm-root policy controls for the voice agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            rootSessionPolicy: 'keep_warm',
            maxWarmRoots: 4,
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    });
    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);

    const policyDropdown = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'keep_warm'));
    if (!policyDropdown) throw new Error('Expected root session policy dropdown');
    expect(policyDropdown.props.selectedId).toBe('keep_warm');
  });

  it('disables the daemon mediator backend option when voice.agent is disabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    featureEnabledState['voice.agent'] = false;
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'openai_compat',
            agentSource: 'agent',
            agentId: 'codex',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const mediatorBackend = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'daemon'));
    if (!mediatorBackend) throw new Error('Expected mediator backend dropdown to be rendered');
    const daemonItem = (mediatorBackend.props.items ?? []).find((it: any) => it?.id === 'daemon');
    expect(daemonItem?.disabled).toBe(true);
  });

  it('keeps the daemon mediator backend option enabled when voice.agent is enabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    featureEnabledState['voice.agent'] = true;
    const setVoice = vi.fn();
    const voice: VoiceSettings = {
      ...withProvider(voiceSettingsDefaults, 'local_conversation'),
      adapters: {
        ...voiceSettingsDefaults.adapters,
        local_conversation: {
          ...voiceSettingsDefaults.adapters.local_conversation,
          conversationMode: 'agent',
          agent: {
            ...voiceSettingsDefaults.adapters.local_conversation.agent,
            backend: 'openai_compat',
            agentSource: 'agent',
            agentId: 'codex',
          },
        },
      },
    };

    let tree!: ReactTestRenderer;
    act(() => {
      tree = renderer.create(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    });

    const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
    const mediatorBackend = dropdowns.find((d: any) => (d.props.items ?? []).some((it: any) => it?.id === 'daemon'));
    if (!mediatorBackend) throw new Error('Expected mediator backend dropdown to be rendered');
    const daemonItem = (mediatorBackend.props.items ?? []).find((it: any) => it?.id === 'daemon');
    expect(daemonItem?.disabled).not.toBe(true);
  });
});
