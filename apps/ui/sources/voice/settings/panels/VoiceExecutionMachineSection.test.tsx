import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { createVoiceProviderRegistry, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

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
    bundled: [{
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.fixture',
      providerId: 'fixture_modes',
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
    providerId: 'fixture_modes',
    providers: {
      ...voiceSettingsDefaults.providers,
      fixture_modes: { schemaVersion: 1, config: { mode } },
    },
  };
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

  it.each(['realtime_openai', 'realtime_grok'] as const)(
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

  it('does not render for ElevenLabs credential or server-feature modes', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const envelope = voiceSettingsDefaults.providers.realtime_elevenlabs;
    const baseConfig = envelope?.config;
    const config = baseConfig !== null && typeof baseConfig === 'object' && !Array.isArray(baseConfig)
      ? baseConfig as Readonly<Record<string, unknown>>
      : {};
    const renderMode = async (billingMode: 'happier' | 'byo') => await renderSettingsView(
      <VoiceExecutionMachineSection
        voice={{
          ...voiceSettingsDefaults,
          providerId: 'realtime_elevenlabs',
          providers: {
            ...voiceSettingsDefaults.providers,
            realtime_elevenlabs: {
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
        fixture_modes: { schemaVersion: 1, config: { mode: 42 } },
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
