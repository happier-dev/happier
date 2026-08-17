import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import type { Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { createVoiceProviderRegistry, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

const storageBoundary = vi.hoisted(() => ({
  settings: null as Settings | null,
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/sync/store/hooks', () => ({
  useAllMachines: () => [
    {
      id: 'machine-1',
      active: true,
      createdAt: 1,
      updatedAt: 1,
      activeAt: 1,
      seq: 1,
      metadata: {
        displayName: 'Primary Mac',
        host: 'primary-mac',
        platform: 'darwin',
        happyCliVersion: '1',
        happyHomeDir: '/h',
        homeDir: '/u',
      },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 1,
    },
  ],
}));

vi.mock('@/sync/domains/state/storage', () => ({
  // Unselected fixtures only need the resolver to fail closed; the focused
  // source-selection cases install their canonical parsed Settings value.
  useSettings: () => storageBoundary.settings ?? ({} as Settings),
}));

function localVoice(providerId: 'local_direct' | 'local_conversation'): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    providerId,
    executionMachine: {
      mode: 'fixed',
      machineId: 'machine-1',
      autoMachineId: 'stale-machine',
    },
  };
}

async function loadSection() {
  return (await import('@/voice/settings/panels/VoiceExecutionMachineSection')).VoiceExecutionMachineSection;
}

function modeRegistry(): VoiceProviderRegistry {
  return createVoiceProviderRegistry({
    builtIn: [{
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.fixture',
      providerId: 'happier.voice.fixture/modes',
      settingsSectionId: 'voice.fixture.modes',
      roles: ['realtime_conversation'],
      requirements: [],
      requirementsByMode: {
        daemon: ['execution_machine'],
        hosted: ['server_feature'],
      },
      supportedPlatforms: ['web'],
      selectionOptions: [
        {
          id: 'daemon',
          modeId: 'daemon',
          order: 1,
          titleKey: 'fixture.daemon.title',
          subtitleKey: 'fixture.daemon.subtitle',
        },
        {
          id: 'hosted',
          modeId: 'hosted',
          order: 2,
          titleKey: 'fixture.hosted.title',
          subtitleKey: 'fixture.hosted.subtitle',
        },
      ],
      projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => {
        const config = envelope?.config;
        const mode = config !== null && typeof config === 'object' && !Array.isArray(config)
          ? (config as Readonly<Record<string, unknown>>).mode
          : null;
        return envelope?.schemaVersion === 1 && (mode === 'daemon' || mode === 'hosted')
          ? { status: 'ready' as const, modeId: mode }
          : { status: 'invalid' as const, modeId: null };
      },
    }],
  });
}

function fixtureVoice(mode: 'daemon' | 'hosted'): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    providerId: 'happier.voice.fixture/modes',
    providers: {
      ...voiceSettingsDefaults.providers,
      'happier.voice.fixture/modes': { schemaVersion: 1, config: { mode } },
    },
  };
}

function agentRealtimeRegistry(): VoiceProviderRegistry {
  const declaration = VoiceProviderContributionSchema.parse({
    id: 'agent-realtime',
    title: 'Agent realtime',
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: { turn: { cancelResponse: false, bargeIn: false } },
    execution: {
      kind: 'experimental_agent_session_realtime',
      agent: 'fixture-agent',
      supportedRuntimeVersions: ['1.2.3'],
    },
    client: { artifactId: 'voice-runtime-web', modulePath: './voice', exportName: 'activate' },
  });
  return createVoiceProviderRegistry({
    bundledContributions: [{
      pluginId: 'happier.agent.fixture',
      providerId: 'happier.agent.fixture/agent-realtime',
      declaration,
    }],
    bundledPresentations: [{
      providerId: 'happier.agent.fixture/agent-realtime',
      settingsSectionId: 'voice.fixture.agent-realtime',
    }],
  });
}

describe('VoiceExecutionMachineSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['local_direct', 'local_conversation'] as const)(
    'renders the shared execution-machine owner for %s',
    async (providerId) => {
      const VoiceExecutionMachineSection = await loadSection();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection voice={localVoice(providerId)} setVoice={() => {}} />,
      );

      const dropdown = screen.findAll(
        (node) => String(node.type) === 'DropdownMenu'
          && node.props?.itemTrigger?.title === t('settingsVoice.local.executionMachine.title'),
      )[0];

      expect(dropdown).toBeTruthy();
      expect(dropdown?.props.selectedId).toBe('machine-1');
      expect(dropdown?.props.items.map((item: any) => item.title)).toEqual([
        t('settingsVoice.local.executionMachine.autoTitle'),
        'Primary Mac',
      ]);
    },
  );

  it.each(['dictation', 'advanced'] as const)(
    'renders on the %s page for daemon-backed Dictation even when the conversation provider is machine-independent',
    async (intent) => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...voiceSettingsDefaults,
      providerId: 'happier.voice.openai/realtime-openai',
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
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={voice}
        setVoice={() => {}}
        intent={intent}
      />,
    );

      expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(1);
    },
  );

  it('stays hidden for device Dictation even when the conversation provider needs a machine', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_direct'),
      dictation: {
        ...voiceSettingsDefaults.dictation,
        sttBinding: 'explicit' as const,
        stt: {
          ...voiceSettingsDefaults.dictation.stt,
          provider: 'device' as const,
        },
      },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={voice}
        setVoice={() => {}}
        intent="dictation"
      />,
    );

    expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
  });

  it.each([
    'happier.voice.google/gemini-stt',
    'happier.voice.openai-compat/stt',
  ] as const)(
    'renders for the declared daemon-executed Dictation provider %s',
    async (providerId) => {
      const VoiceExecutionMachineSection = await loadSection();
      const voice = {
        ...voiceSettingsDefaults,
        providers: providerId === 'happier.voice.openai-compat/stt'
          ? {
              ...voiceSettingsDefaults.providers,
              [providerId]: {
                schemaVersion: 2,
                config: {
                  baseUrl: 'https://speech.example.test/v1',
                  insecureLocalOriginConsent: '',
                  insecureLocalConsentMachineId: '',
                  model: 'whisper-1',
                  language: '',
                },
              },
            }
          : voiceSettingsDefaults.providers,
        dictation: {
          ...voiceSettingsDefaults.dictation,
          sttBinding: 'explicit' as const,
          stt: {
            ...voiceSettingsDefaults.dictation.stt,
            provider: providerId,
          },
        },
      };
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection
          voice={voice}
          setVoice={() => {}}
          intent="dictation"
        />,
      );

      expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(1);
    },
  );

  it('exposes and updates the execution machine for an Agent-realtime declaration', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const setVoice = vi.fn();
    const voice = {
      ...voiceSettingsDefaults,
      providerId: 'happier.agent.fixture/agent-realtime',
      providers: {
        ...voiceSettingsDefaults.providers,
        'happier.agent.fixture/agent-realtime': { schemaVersion: 1, config: {} },
      },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={voice}
        setVoice={setVoice}
        registry={agentRealtimeRegistry()}
      />,
    );
    const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];

    expect(dropdown).toBeTruthy();
    dropdown?.props.onSelect('machine-1');
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      executionMachine: expect.objectContaining({ mode: 'fixed', machineId: 'machine-1' }),
    }));
  });

  it('clears both fixed and sticky-auto machine ids when the user explicitly selects Automatic', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const setVoice = vi.fn();
    const voice = localVoice('local_conversation');
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={setVoice} />,
    );
    const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];

    dropdown?.props.onSelect('auto');

    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      executionMachine: {
        mode: 'auto',
        machineId: null,
        autoMachineId: null,
      },
    }));
  });

  it('keeps an unavailable fixed machine visible instead of presenting Automatic', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'fixed' as const, machineId: 'missing-machine', autoMachineId: null },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} />,
    );
    const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];

    expect(dropdown?.props.itemTrigger.detailFormatter()).toBe('missing-machine');
  });

  it('shows the sticky resolved machine in the Automatic selection', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'auto' as const, machineId: null, autoMachineId: 'machine-1' },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} />,
    );
    const dropdown = screen.findAll((node) => String(node.type) === 'DropdownMenu')[0];

    expect(dropdown?.props.itemTrigger.detailFormatter()).toContain('Primary Mac');
  });

  it.each([
    ['daemon', 1],
    ['hosted', 0],
  ] as const)('projects execution-machine visibility from the selected mode requirements: %s', async (mode, expectedCount) => {
    const VoiceExecutionMachineSection = await loadSection();
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={fixtureVoice(mode)}
        setVoice={() => {}}
        registry={modeRegistry()}
      />,
    );

    expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(expectedCount);
  });

  it.each(['happier.voice.openai/realtime-openai', 'happier.voice.xai/realtime-grok'] as const)(
    'does not render for the canonical credential-only %s BYO contribution',
    async (providerId) => {
      const VoiceExecutionMachineSection = await loadSection();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection
          voice={{ ...voiceSettingsDefaults, providerId }}
          setVoice={() => {}}
        />,
      );

      expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
    },
  );

  it.each([
    ['Connected Account', 'connectedAccount', 1],
    ['SavedSecret', 'savedSecret', 0],
  ] as const)('uses the selected %s source when projecting execution-machine visibility', async (_label, sourceKind, expectedCount) => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const {
      applyAccountVoiceCredentialSourceSelection,
      upsertAccountVoiceCredential,
    } = await import('@/voice/credentials/accountVoiceCredential');
    const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
    const provider = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
      throw new Error('expected_openai_voice_provider');
    }
    const voice = {
      ...voiceSettingsDefaults,
      providerId: provider.providerId,
    };
    const initial = settingsParse({ voice });
    const contribution = { pluginId: provider.pluginId, localId: provider.declaration.id };
    const withSavedSecret = sourceKind === 'savedSecret'
      ? upsertAccountVoiceCredential({
          settings: initial,
          contribution,
          credentialSlotId: provider.declaration.credentials!.slot.id,
          value: 'sk-saved',
          generateId: () => 'saved-openai-secret',
          now: 1,
          expectedSecretId: null,
          expectedSecretUpdatedAt: null,
        }).settings
      : initial;
    const selected = applyAccountVoiceCredentialSourceSelection({
      settings: withSavedSecret,
      mutation: {
        contribution,
        credentialSlotId: provider.declaration.credentials!.slot.id,
        selection: sourceKind === 'connectedAccount'
          ? {
              kind: 'connectedAccount',
              target: {
                kind: 'account',
                account: {
                  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                  accountId: 'codex-work',
                },
              },
            }
          : { kind: 'savedSecret' },
        expectedSettingsVersion: 1,
      },
      currentDeclaration: provider.declaration,
    });
    storageBoundary.settings = selected.settings;
    try {
      const VoiceExecutionMachineSection = await loadSection();
      const setVoice = vi.fn();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection voice={selected.settings.voice} setVoice={setVoice} />,
      );
      const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
      expect(dropdowns).toHaveLength(expectedCount);
      if (sourceKind === 'connectedAccount') {
        const dropdown = dropdowns[0];
        expect(dropdown).toBeTruthy();
        dropdown?.props.onSelect('machine-1');
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
          executionMachine: expect.objectContaining({ mode: 'fixed', machineId: 'machine-1' }),
        }));
      }
    } finally {
      storageBoundary.settings = null;
    }
  });

  it('does not render for ElevenLabs credential or server-feature modes', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const envelope = voiceSettingsDefaults.providers['happier.voice.elevenlabs/realtime-elevenlabs'];
    const baseConfig = envelope?.config;
    const config = baseConfig !== null && typeof baseConfig === 'object' && !Array.isArray(baseConfig)
      ? baseConfig as Readonly<Record<string, unknown>>
      : {};
    const renderMode = async (billingMode: 'happier' | 'byo') => await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={{
          ...voiceSettingsDefaults,
          providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
          providers: {
            ...voiceSettingsDefaults.providers,
            'happier.voice.elevenlabs/realtime-elevenlabs': {
              schemaVersion: envelope?.schemaVersion ?? 2,
              config: { ...config, billingMode },
            },
          },
        }}
        setVoice={() => {}}
      />,
    );

    expect((await renderMode('byo')).findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
    expect((await renderMode('happier')).findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
  });

  it.each([
    ['unknown provider', { ...voiceSettingsDefaults, providerId: 'unknown_fixture' }],
    ['malformed settings', {
      ...fixtureVoice('daemon'),
      providers: {
        ...fixtureVoice('daemon').providers,
        'happier.voice.fixture/modes': { schemaVersion: 1, config: { mode: 42 } },
      },
    }],
  ])('fails closed for %s', async (_label, voice) => {
    const VoiceExecutionMachineSection = await loadSection();
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} registry={modeRegistry()} />,
    );

    expect(screen.findAll((node) => String(node.type) === 'DropdownMenu')).toHaveLength(0);
  });
});
