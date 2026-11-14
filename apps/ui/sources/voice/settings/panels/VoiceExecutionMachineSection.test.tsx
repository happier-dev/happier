import * as React from 'react';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { act } from 'react-test-renderer';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { t } from '@/text';
import { AuthProvider } from '@/auth/context/AuthContext';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET } from '@/voice/settings/voiceSettingsRouteFocus';
import { createVoiceProviderRegistry, type VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from './voiceSettingsAccountTestHarness';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { useVoiceExecutionMachinePresentation, type VoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

// Static settings imports reach Sync before collection-time boundary configuration.
vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

// This third-party SDK export is unavailable on some workers and is never used by these settings rows.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in Voice settings test'); },
}));


let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
const storageBoundary = {
  get settings() { return storage.getState().settings; },
  set settings(value: Settings | null) { account.replaceSettings(value ?? settingsDefaults); },
};
installDisconnectedServerSocketBoundary();

beforeEach(async () => {
  account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
  onTestFinished(account.dispose);
  const machine = createMachineFixture({ metadata: {
    displayName: 'Primary Mac', host: 'primary-mac', platform: 'darwin',
    happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u',
  } });
  storage.getState().applyMachines([machine], true, { sourceServerId: account.scope.serverId });
});

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

// Native/browser portal measurement is the system boundary; menu logic remains real.
vi.mock('@/components/ui/popover', async (importOriginal) => (
  await import('@/dev/testkit/mocks/popover')
).createInlinePopoverModuleMock(importOriginal));



function localVoice(providerId: 'local_direct' | 'local_conversation'): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    providerId,
    executionMachine: {
      mode: 'fixed',
      machineId: 'machine-1',
    },
  };
}

async function loadSection() {
  return (await import('@/voice/settings/panels/VoiceExecutionMachineSection')).VoiceExecutionMachineSection;
}

// Resolve the real registry/settings graph during collection rather than inside a timed interaction.
const VoiceExecutionMachineSection = await loadSection();
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');

it('opens the Machine picker when typed Voice recovery navigates to the Conversations screen', async () => {
  // The opened chooser is a phone sheet that follows the browser window's resizes: stub that boundary here.
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, setTimeout, clearTimeout,
    visualViewport: undefined, innerWidth: 390, innerHeight: 844 });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  account.replaceVoice(localVoice('local_conversation'));
  const writesBeforeRecovery = account.writes.length;
  const target = VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET;
  const screen = await renderSettingsView(
    <AuthProvider initialCredentials={account.credentials}>
      <DestinationInstanceHost tabId="voice-machine-recovery" ref={{ kind: 'settings', params: target.params }}
        pathname={target.pathname} navigation={{ push: vi.fn(), replace: vi.fn(), back: vi.fn() }} focused visible>
        <VoiceConversationsSettingsScreen />
      </DestinationInstanceHost>
    </AuthProvider>,
  );
  try {
    // Recovery opens the header's "Runs on" chooser: New Session's Machine picker, led by Automatic.
    const chip = screen.tree.root.findAll((node) => node.props.filter?.testID === 'settings.voice.executionMachine.chip')[0];
    expect(chip?.props.filter.open).toBe(true);
    expect(screen.findHostByTestId('settings.voice.executionMachine.chip-machine-option:default')).not.toBeNull();
    expect(account.writes.length - writesBeforeRecovery).toBe(0);
  } finally {
    await screen.unmount();
  }
});

it('keeps the Advanced Voice computer available for model management when conversations are off', async () => {
  const voice: VoiceSettings = { ...voiceSettingsDefaults, providerId: null, dictation: {
    ...voiceSettingsDefaults.dictation, sttBinding: 'explicit', stt: { ...voiceSettingsDefaults.dictation.stt, provider: 'device' },
  } };
  const setVoice = vi.fn();
  const view = await renderSettingsView(<VoiceExecutionMachineSection voice={voice} setVoice={setVoice} intent="advanced" />);
  const picker = view.tree.root.findAll((node) => node.type === SessionMachineField)[0];
  expect(picker).toBeDefined();
  await act(async () => { picker!.props.onSelectMachine(createMachineFixture({ id: 'machine-1' })); });
  expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
    providerId: null, executionMachine: { mode: 'fixed', machineId: 'machine-1' },
  }));
});

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
    client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
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
  it('expires the mounted picker and selected target through the shared presence clock without a store write', async () => {
    const voice = localVoice('local_conversation');
    account.replaceVoice(voice);
    storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now() })], true,
      { sourceServerId: account.scope.serverId, sourceAccountId: account.scope.accountId });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let latest: VoiceExecutionMachinePresentation | undefined;
    function Surface() {
      latest = useVoiceExecutionMachinePresentation();
      return <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} intent="advanced" />;
    }
    const screen = await renderSettingsView(<Surface />);
    expect(latest?.selectionKind).toBe('resolved');
    const rows = storage.getState().machineListByServerId;
    await act(async () => { vi.advanceTimersByTime(60_001); });
    expect(storage.getState().machineListByServerId).toBe(rows);
    expect(latest?.selectionKind).toBe('selected_unreachable');
    await screen.unmount();
  });

  it('retains the mounted chip presence through transport withdrawal until activity updates', async () => {
    const presentation = 'chip' as const;
    onTestFinished(clearMachineRequestReachabilityForTest);
    onTestFinished(() => { vi.useRealTimers(); });
    const voice = localVoice('local_conversation');
    account.replaceVoice(voice);
    storage.getState().applyMachines([createMachineFixture({ active: true, activeAt: Date.now() })], true,
      { sourceServerId: account.scope.serverId, sourceAccountId: account.scope.accountId });
    const screen = await renderSettingsView(<VoiceExecutionMachineSection voice={voice} setVoice={() => {}}
      intent="advanced" presentation={presentation} />);
    const chip = () => screen.tree.root.findAll((node) => node.props.filter?.testID === 'settings.voice.executionMachine.chip')[0]!;
    const read = () => chip().props.filter.presence;
    expect(read()).toBe('online');
    const rows = storage.getState().machineListByServerId;
    await act(async () => { withdrawMachinePresenceForScope(account.scope); });
    expect(storage.getState().machineListByServerId).toBe(rows);
    // Transport withdrawal supplies no Machine activity fact; the existing activity remains authoritative.
    expect(read()).toBe('online');
    await act(async () => { captureMachinePresenceObservation({ ...account.scope, accountId: 'other-account' })(['machine-1']); });
    expect(read()).toBe('online');
    await act(async () => { captureMachinePresenceObservation(account.scope)(['machine-1']); });
    expect(read()).toBe('online');
    const lastSeenAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(lastSeenAt + 60_002);
    await act(async () => {
      storage.getState().applyMachines([createMachineFixture({ active: false, activeAt: lastSeenAt + 1 })], true,
        { sourceServerId: account.scope.serverId, sourceAccountId: account.scope.accountId });
    });
    expect(read()).toBe('offline');
    await screen.unmount();
  });

  beforeEach(() => {
    useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
    vi.clearAllMocks();
  });

  it.each(['local_direct', 'local_conversation'] as const)(
    'renders the shared execution-machine owner for %s',
    async (providerId) => {
      const VoiceExecutionMachineSection = await loadSection();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection voice={localVoice(providerId)} setVoice={() => {}} />,
      );

      const field = screen.findAll(
        (node) => node.type === SessionMachineField
          && node.props?.title === t('settingsVoice.pages.conversations.runsOn'),
      )[0];

      expect(field).toBeTruthy();
      expect(field?.props.machineId).toBe('machine-1');
      // New Session's Machine picker lists the Machines; Automatic leads it.
      expect(field?.props.defaultChoice.title).toBe(t('settingsVoice.local.executionMachine.autoTitle'));
    },
  );

  it.each(['dictation', 'advanced'] as const)(
    'renders on the %s page for daemon-backed Dictation with a realtime conversation provider',
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

      expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(1);
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

    expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(0);
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

      expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(1);
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
    const dropdown = screen.findAll((node) => node.type === SessionMachineField)[0];

    expect(dropdown).toBeTruthy();
    dropdown?.props.onSelectMachine(createMachineFixture({ id: 'machine-1' }));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      executionMachine: expect.objectContaining({ mode: 'fixed', machineId: 'machine-1' }),
    }));
  });

  it('clears both fixed and sticky-auto machine ids when the user explicitly selects Automatic', async () => {
    const scope = storage.getState().settingsScope!;
    useVoiceTargetStore.getState().rememberAutoTargetMachine(scope, 'stale-machine');
    const VoiceExecutionMachineSection = await loadSection();
    const setVoice = vi.fn();
    const voice = localVoice('local_conversation');
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={setVoice} />,
    );
    const dropdown = screen.findAll((node) => node.type === SessionMachineField)[0];

    dropdown?.props.defaultChoice.onChoose();
    expect(useVoiceTargetStore.getState().autoTargetMachineByScope[accountSettingsScopeKeySuffix(scope)]).toBeNull();

    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      executionMachine: {
        mode: 'auto',
        machineId: null,
      },
    }));
  });

  it('labels the header chip with what it decides, beside the machine it names', async () => {
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'fixed' as const, machineId: 'machine-1' },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} intent="advanced" presentation="chip" />,
    );

    expect(screen.getTextContent()).toContain(t('settingsVoice.pages.conversations.runsOn'));
  });

  it('keeps an unavailable fixed machine visible instead of presenting Automatic', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'fixed' as const, machineId: 'missing-machine' },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} />,
    );
    const dropdown = screen.findAll((node) => node.type === SessionMachineField)[0];

    expect(dropdown?.props.machineName).toBe(t('machine.unlistedMachine'));
    expect(dropdown?.props.machineId).toBe('missing-machine');
  });

  it('names the machine Automatic uses before any conversation has remembered one', async () => {
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'auto' as const, machineId: null },
    };
    account.replaceVoice(voice);
    // Automatic picks among online machines; the shared fixture's activity is long past.
    storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now(), metadata: {
      displayName: 'Primary Mac', host: 'primary-mac', platform: 'darwin',
      happyCliVersion: '1', happyHomeDir: '/h', homeDir: '/u',
    } })], true, { sourceServerId: account.scope.serverId });
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} intent="advanced" />,
    );
    const dropdown = screen.findAll((node) => node.type === SessionMachineField)[0];

    expect(dropdown?.props.defaultChoice.value).toBe(`${t('settingsVoice.local.executionMachine.autoTitle')} · Primary Mac`);
  });

  it('shows the sticky resolved machine in the Automatic selection', async () => {
    useVoiceTargetStore.getState().rememberAutoTargetMachine(storage.getState().settingsScope!, 'machine-1');
    const VoiceExecutionMachineSection = await loadSection();
    const voice = {
      ...localVoice('local_conversation'),
      executionMachine: { mode: 'auto' as const, machineId: null },
    };
    const screen = await renderSettingsView(
      <VoiceExecutionMachineSection voice={voice} setVoice={() => {}} />,
    );
    const dropdown = screen.findAll((node) => node.type === SessionMachineField)[0];

    expect(dropdown?.props.defaultChoice.value).toContain('Primary Mac');
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

    expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(expectedCount);
  });

  it.each(['happier.voice.openai/realtime-openai', 'happier.voice.xai/realtime-grok'] as const)(
    'keeps the adapter Machine chooser reachable for %s with no usable Machine or saved credential source',
    async (providerId) => {
      storage.getState().applyMachines([], true, { sourceServerId: account.scope.serverId, sourceAccountId: account.scope.accountId });
      const VoiceExecutionMachineSection = await loadSection();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection
          voice={{ ...voiceSettingsDefaults, providerId }}
          setVoice={() => {}}
        />,
      );

      expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(1);
    },
  );

  it.each([
    ['Connected Account', 'connectedAccount', 1],
    ['SavedSecret', 'savedSecret', 1],
  ] as const)('uses the selected %s source when projecting execution-machine visibility', async (_label, sourceKind, expectedCount) => {
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const {
      applyAccountVoiceCredentialSourceSelection,
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
    const selected = sourceKind === 'savedSecret'
      ? { settings: await withVoiceSettingsCredentialResource(account, {
          settings: initial,
          declaration: provider.declaration,
          pluginId: provider.pluginId,
          resourceId: 'saved-openai-secret',
        }) }
      : applyAccountVoiceCredentialSourceSelection({
          settings: initial,
          connectedPurposes: account.purposes.value,
          mutation: {
            contribution,
            credentialSlotId: provider.declaration.credentials!.slot.id,
            selection: {
              kind: 'connectedAccount',
              target: {
                kind: 'account',
                account: {
                  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                  accountId: 'codex-work',
                },
              },
            },
            expectedSettingsVersion: 1,
          },
          currentDeclaration: provider.declaration,
        });
    if ('connectedPurposes' in selected) await account.replaceConnectedPurposes(selected.connectedPurposes);
    storageBoundary.settings = selected.settings;
    await refreshSavedSecretCatalog(account.scope);
    try {
      const VoiceExecutionMachineSection = await loadSection();
      const setVoice = vi.fn();
      const screen = await renderSettingsView(
        <VoiceExecutionMachineSection voice={selected.settings.voice} setVoice={setVoice} />,
      );
      const dropdowns = screen.findAll((node) => node.type === SessionMachineField);
      expect(dropdowns).toHaveLength(expectedCount);
      const dropdown = dropdowns[0];
      expect(dropdown).toBeTruthy();
      dropdown?.props.onSelectMachine(createMachineFixture({ id: 'machine-1' }));
      expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
        executionMachine: expect.objectContaining({ mode: 'fixed', machineId: 'machine-1' }),
      }));
    } finally {
      storageBoundary.settings = null;
    }
  });

  it('keeps the adapter Machine available for ElevenLabs credential and server-feature modes', async () => {
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
              config: { ...config, billingMode, agentId: 'agent-machine-picker' },
            },
          },
        }}
        setVoice={() => {}}
      />,
    );

    expect((await renderMode('byo')).findAll((node) => node.type === SessionMachineField)).toHaveLength(1);
    expect((await renderMode('happier')).findAll((node) => node.type === SessionMachineField)).toHaveLength(1);
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

    expect(screen.findAll((node) => node.type === SessionMachineField)).toHaveLength(0);
  });
});
