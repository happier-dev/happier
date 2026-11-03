import * as React from 'react';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceLocalConversationSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { createDeferred, flushHookEffects, pressTestInstanceAsync, renderSettingsView as renderSettingsViewWithProviders,
  standardCleanup, waitForTestEvent, type SettingsViewHarness } from '@/dev/testkit';
import { sync } from '@/sync/sync';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { t } from '@/text';
import { PluginProjectionV2Schema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveVoiceConfiguredAgentTarget } from '@/voice/agent/resolveVoiceConfiguredAgentTarget';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { refreshAuthenticatedServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { createProviderSettingsHarness,
  createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover';

vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const providerTransport = createProviderSettingsHarness();
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let rowDefinitions: readonly unknown[];
async function publishMachineCensus() {
  if (!account) throw new Error('Expected a restored test Account');
  await fetchAndApplyMachines({ credentials: account.credentials, expectedAccountMode: 'plain', encryption: null,
    machineDataKeys: new Map(), sourceServerId: account.home.id, throwOnError: true, replace: true,
    applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace, { sourceServerId: account!.home.id }),
  });
}


(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const platformOsMock = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ params: () => routeParams.value }).module;
});
// These daemon responses are emitted at the Socket.IO wire boundary below;
// the scoped RPC adapter, catalogs and capability parsing stay real.
const registryDescribe = vi.hoisted(() => vi.fn<
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe
>());

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
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

// Model discovery crosses the daemon RPC boundary; model/preflight owners remain real.
const capabilitiesInvoke = vi.hoisted(() => vi.fn<typeof import('@/sync/ops/capabilities').machineCapabilitiesInvoke>());
let capabilitiesCompleted = createDeferred<void>();
installSessionActionRpcBoundary(async request => {
  const separator = request.method.indexOf(':');
  const machineId = request.method.slice(0, separator);
  const method = request.method.slice(separator + 1);
  if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
    const response = await registryDescribe(machineId);
    return response.supported ? { protocolVersion: 1, projection: response.projection } : { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
  }
  if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
    const response = await capabilitiesInvoke(machineId, request.params as Parameters<typeof capabilitiesInvoke>[1]);
    capabilitiesCompleted.resolve();
    return response.supported ? response.response : { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
  }
  return providerTransport.machineRpc({ machineId, serverId: account?.home.id ?? null,
    accountId: 'voice-account', method, payload: request.params });
});

type LocalConversationAgentOverrides = Partial<VoiceLocalConversationSettings['agent']> & {
  machineTargetMode?: 'auto' | 'fixed';
  machineTargetId?: string | null;
  autoTargetMachineId?: string | null;
  welcome?: Partial<VoiceSettings['welcome']>;
};

type LocalConversationAdapterOverrides = Partial<Omit<VoiceLocalConversationSettings, 'agent'>> & {
  agent?: LocalConversationAgentOverrides;
};

const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) => {
  callback(100, 120, 280, 48);
});

function SettingsOverlayProviders({ children }: React.PropsWithChildren) {
  return <OverlayPortalProvider>{children}<OverlayPortalHost /></OverlayPortalProvider>;
}

function renderSettingsView(element: React.ReactElement) {
  return renderSettingsViewWithProviders(element, {
    wrapper: SettingsOverlayProviders,
    createNodeMock: node => typeof node.type === 'string' ? { measureInWindow } : null,
  });
}

async function openDropdown(screen: SettingsViewHarness, title: string) {
  const dropdown = findDropdownByItemTriggerTitle(screen, title);
  if (!dropdown) throw new Error('Expected the real settings dropdown');
  const triggers = dropdown.findAll(node => typeof node.type === 'string'
    && typeof node.props.onPress === 'function' && node.props.accessibilityState?.expanded === false);
  expect(triggers).toHaveLength(1);
  await pressTestInstanceAsync(triggers[0]!);
  await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  await waitForTestEvent(screen.subscribe, () => expect(measureInWindow).toHaveBeenCalled());
  expect(dropdown.props.open).toBe(true);
  return dropdown;
}

async function selectDropdownOption(screen: SettingsViewHarness, title: string, optionTestID: string) {
  const dropdown = await openDropdown(screen, title);
  const option = screen.findAllHostsByTestId(optionTestID)
    .find(node => String(node.type) === 'Pressable');
  if (!option) throw new Error('Expected the real portaled settings option');
  let portalHost = option.parent;
  while (portalHost && portalHost.type !== OverlayPortalHost) portalHost = portalHost.parent;
  expect(portalHost).not.toBeNull();
  await pressTestInstanceAsync(option);
  await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  expect(dropdown.props.open).toBe(false);
}

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
  return screen.findAll((node) => node.type === DropdownMenu && node.props?.itemTrigger?.title === title)[0] ?? null;
}

/** A choice row with its options always visible (two to four short options). */
function findSegmentedChoiceByTitle(
  screen: Pick<SettingsViewHarness, 'findAll'>,
  title: string,
) {
  return screen.findAll((node) => Array.isArray(node.props?.options) && typeof node.props?.onChange === 'function' && node.props?.title === title)[0] ?? null;
}

/** Any single-choice control for a setting, whether a menu or a segmented row. */
function findChoiceByTitle(
  screen: Pick<SettingsViewHarness, 'findAll'>,
  title: string,
) {
  return findDropdownByItemTriggerTitle(screen, title) ?? findSegmentedChoiceByTitle(screen, title);
}

/** Opens "Advanced agent behaviour", the disclosure that holds the Voice agent's lifecycle, commit and streaming rows. */
function openAdvancedAgent(screen: Pick<SettingsViewHarness, 'findAll'>) {
  const disclosure = screen.findAll((node) => node.props?.testID === 'settings.voice.local.advancedAgent'
    && typeof node.props?.onExpandedChange === 'function')[0];
  if (!disclosure) throw new Error('Expected the advanced agent disclosure');
  act(() => disclosure.props.onExpandedChange(true));
}

beforeEach(async () => {
  capabilitiesCompleted = createDeferred<void>();
  measureInWindow.mockClear();
  account = undefined;
  routeParams.value = {};
  rowDefinitions = [];
  providerTransport.reset();
  useVoiceTargetStore.setState({ autoTargetMachineByScope: {} });
  clearDaemonMergedProjectionCacheForTests();
  registryDescribe.mockResolvedValue({
    supported: true,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      agentsById: {
        'com.acme.voice.agent': {
          id: 'com.acme.voice.agent',
          identity: { pluginId: 'com.acme.voice', localId: 'agent' },
          title: 'Acme Voice',
          subtitle: 'External conversation Agent',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        },
      },
      familiesById: {},
    }),
  });
  platformOsMock.value = 'ios';
  resetServerFeaturesClientForTests();
  account = await restoreServerAccountForTest({ serverUrl: 'https://voice-selection.example.test', accountId: 'voice-account',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features' || path === '/v1/features/authenticated') {
        const features = buildServerFeaturesResponse({ voiceEnabled: true });
        features.features.providers.enabled = true;
        return Response.json(features);
      }
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {
        experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true },
      } } });
      if (path === '/v1/artifacts') return Response.json([]);
      const machineId = path.startsWith('/v1/machines/') ? decodeURIComponent(path.slice('/v1/machines/'.length)) : null;
      const machineRow = (id: string) => {
        const machine = storage.getState().machines[id];
        return MachinePublishedRowV1Schema.parse({ ...createPlainMachineRowFixture({ id, accountId: 'voice-account' }),
          ...(machine ? { ...machine, metadata: encodePlainMachineStoredContent(machine.metadata),
            daemonState: encodePlainMachineStoredContent(machine.daemonState) } : {}) });
      };
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, machineRow);
      if (machineId) return Response.json({ machine: machineRow(machineId) });
      if (path === '/v1/machines') return Response.json(Object.keys(storage.getState().machines).map(machineRow));
      if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
      if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 3,
        content: { t: 'plain', v: { v: 1, definitions: rowDefinitions } } });
      return new Response(null, { status: 404 });
    },
  });
  const scope = { serverId: account.home.id, accountId: 'voice-account' };
  await sync.refreshAccountSettingsFromServer(4, scope);
  await updateEffectiveHomeViewState(() => ({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: account!.home.id }), { scope: 'device' });
  storage.setState({
    settingsScope: scope,
    profileScope: scope,
    settings: settingsParse({ experiments: true, featureToggles: { 'voice.agent': true, 'execution.runs': true } }),
    machines: {
      'machine-1': createMachineFixture({ activeAt: Date.now() }),
      'machine-2': createMachineFixture({ id: 'machine-2', active: false, createdAt: 2, updatedAt: 2, activeAt: 2 }),
    },
  });
  await publishMachineCensus();
  await refreshAcpCatalog(scope);
  await refreshAuthenticatedServerFeaturesSnapshot({ serverId: account.home.id, credentials: account.credentials });
  storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'machine-1', path: '/tmp/repo' }] });
  resetDynamicModelProbeCacheForTests();
  capabilitiesInvoke.mockReset();
  capabilitiesInvoke.mockResolvedValue({ supported: true, response: { ok: true, result: {
    availableModels: [{ id: 'm1', name: 'Model 1' }, { id: 'codex-dynamic-1', name: 'Codex Dynamic 1' }],
    supportsFreeform: true,
  } } });
});
afterEach(async () => {
  standardCleanup();
  resetAcpCatalogEngineForTests();
  resetAcpCatalogSnapshotsForTests();
  await account?.dispose();
  vi.restoreAllMocks();
});

// Collect the real renderer graph before timed interactions (cold transforms are not behavior).
const localConversationModule = await import('@/voice/settings/panels/LocalConversationSection');
async function loadLocalConversationSection() {
  return localConversationModule.LocalConversationSection;
}

describe('LocalConversationSection', () => {
  it.each(['ready', 'incomplete'] as const)('uses %s exact destination facts for Voice memory resume availability', async (status) => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'claude', name: 'configured-claude', title: 'Configured Claude',
      launch: { kind: 'command' as const, command: 'review', args: [] }, capabilities: { supportsLoadSession: true }, createdAt: 1, updatedAt: 1 });
    rowDefinitions = status === 'ready' ? [definition] : [definition, { id: 'malformed-neighbor' }];
    const scope = { serverId: account!.home.id, accountId: 'voice-account' };
    await refreshAcpCatalog(scope);
    expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe(status === 'ready' ? 'ready' : 'partial');
    const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
    const voice = createLocalConversationVoice({ agent: { agentSource: 'agent', agentId: 'claude',
      agentTargetKey: 'backend:claude:configured:claude', transcript: { persistenceMode: 'persistent' } } });
    expect(readLocalConversationVoiceSettings(voice).agent).toMatchObject({
      agentSource: 'agent', agentId: 'claude', agentTargetKey: 'backend:claude:configured:claude', resumabilityMode: 'replay',
    });
    const screen = await renderSettingsView(<VoiceAgentMemorySection voice={voice} setVoice={vi.fn()} />);
    const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
    const resume = restore?.props.options.find((option: { id: string }) => option.id === 'provider_resume');
    expect(resume).toBeDefined();
    if (status === 'ready') expect(resume?.unavailableReason).toBeUndefined();
    else expect(typeof resume?.unavailableReason).toBe('string');
  });

  it('shows an unavailable selection for an abstract ACP Agent without crashing or probing a substitute', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: {
      agentSource: 'agent', agentId: 'custom-acp', agentTargetKey: null, agentIdentity: null,
    } });
    const setVoice = vi.fn();
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const picker = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'));
    expect(picker?.props.itemTrigger.subtitleFormatter()).toBe(t('settingsVoice.local.machineErrors.agent_selection_unavailable'));
    expect(capabilitiesInvoke).not.toHaveBeenCalled();
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('offers a configured Agent from destination rows without a Settings catalog root', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 })];
    await refreshAcpCatalog({ serverId: account!.home.id, accountId: 'voice-account' });
    const LocalConversationSection = await loadLocalConversationSection();
    const changed = createDeferred<void>();
    const setVoice = vi.fn<(voice: VoiceSettings) => void>(() => { changed.resolve(); });
    const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: { agentSource: 'agent', agentId: 'codex' } });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const picker = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'));
    const rowTargetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:row-review';
    expect(picker?.props.items.find((item: { id: string }) => item.id === rowTargetKey)).toMatchObject({ title: 'Row review' });
    await selectDropdownOption(screen, t('settingsVoice.local.mediatorAgentId'),
      'dropdown-option-agent_happier_agent_custom-acp_custom-acp_definition_row-review');
    await changed.promise;
    expect(setVoice).toHaveBeenCalledOnce();
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0]).agent).toMatchObject({
      agentId: 'custom-acp', agentTargetKey: rowTargetKey,
    });
    await screen.update(<LocalConversationSection voice={setVoice.mock.calls[0]![0]} setVoice={setVoice} />);
    expect(findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'))?.props.selectedId).toBe(rowTargetKey);
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: 'machine-1',
      selection: readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0]).agent,
    })).resolves.toMatchObject({ ok: true, backendTarget: {
      kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review', sourceKind: 'configured',
    } });
  });

  it('draws the Hands-free timing rows only while Hands-free is on', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const timingFields = (screen: Awaited<ReturnType<typeof renderSettingsView>>) => screen.findAll((node) => typeof node.props.fieldTestID === 'string'
      && /handsFree\.(silenceMs|minSpeechMs)\.field$/u.test(node.props.fieldTestID));

    const off = await renderSettingsView(<LocalConversationSection
      voice={createLocalConversationVoice({ handsFree: { ...defaults.handsFree, enabled: false } })}
      setVoice={() => {}}
    />);
    expect(timingFields(off)).toHaveLength(0);

    const on = await renderSettingsView(<LocalConversationSection
      voice={createLocalConversationVoice({ handsFree: { ...defaults.handsFree, enabled: true } })}
      setVoice={() => {}}
    />);
    expect(timingFields(on).length).toBeGreaterThan(0);
  });

  it('shows Hear timing in seconds but saves milliseconds through the existing owner', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = createLocalConversationVoice({ handsFree: {
      ...defaults.handsFree, enabled: true, endpointing: { silenceMs: 800, minSpeechMs: 300 },
    } });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const silence = screen.findAll((node) => node.props.fieldTestID === 'settings.voice.local.handsFree.silenceMs.field')[0]!;
    expect(silence.props.value).toBe('0.8');
    act(() => silence.props.onCommit('1.2'));
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]![0]).handsFree.endpointing).toEqual({ silenceMs: 1200, minSpeechMs: 300 });
  });
  it.each(['permissionIntent', 'idleTtlSeconds', 'chatModelId', 'commitModelId'] as const)(
    'reveals the real %s row and inline editor without changing settings', async (id) => {
      const LocalConversationSection = await loadLocalConversationSection();
      const setVoice = vi.fn();
      const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: {
        agentSource: 'agent', chatModelSource: 'custom', chatModelId: 'unlisted-chat',
        commitModelSource: 'custom', commitModelId: 'unlisted-commit',
      } });
      const render = () => <LocalConversationSection voice={voice} setVoice={setVoice} />;
      const screen = await renderSettingsView(render());
      const setting = VOICE_CONVERSATIONS_SETTINGS.settings[id];
      routeParams.value = { setting: setting.anchor };
      await act(async () => screen.update(render()));
      expect(screen.findAllByProps({ nativeID: `setting-${setting.anchor}` }).length).toBeGreaterThan(0);
      expect(screen.findAllByProps({ testID: `setting-reveal.${setting.anchor}` }).length).toBeGreaterThan(0);
      if (id === 'idleTtlSeconds' || id === 'commitModelId') {
        expect(screen.findAll((node) => node.props.testID === 'settings.voice.local.advancedAgent'
          && node.props.expanded === true).length).toBeGreaterThan(0);
      }
      if (id === 'chatModelId' || id === 'commitModelId') {
        const field = screen.findAll((node) => node.props.fieldTestID === `settings.voice.local.${id}.custom.field`)[0];
        expect(field?.props.value).toBe(id === 'chatModelId' ? 'unlisted-chat' : 'unlisted-commit');
      }
      expect(setVoice).not.toHaveBeenCalled();
    },
  );
  it('refuses an unavailable Agent choice, preserves it, and allows leaving or enabling it', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    storage.getState().applySettingsLocal({ featureToggles: { 'voice.agent': false, 'execution.runs': true } });
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({ conversationMode: 'direct_session' });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const choice = () => findSegmentedChoiceByTitle(screen, t('settingsVoice.pages.conversations.talkToTitle'));
    const unavailableAgent = choice()?.props.options.find((option: { id: string }) => option.id === 'agent');
    expect(unavailableAgent.unavailableReason ?? unavailableAgent.disabled).toBeTruthy();
    act(() => choice()?.props.onChange('agent'));
    expect(setVoice).not.toHaveBeenCalled();
    const stored = createLocalConversationVoice({ conversationMode: 'agent' });
    await act(async () => screen.update(<LocalConversationSection voice={stored} setVoice={setVoice} />));
    expect(choice()?.props.value).toBe('agent');
    act(() => choice()?.props.onChange('direct_session'));
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]?.[0]).conversationMode).toBe('direct_session');
    setVoice.mockClear();
    await act(async () => storage.getState().applySettingsLocal({ featureToggles: { 'voice.agent': true, 'execution.runs': true } }));
    await act(async () => screen.update(<LocalConversationSection voice={voice} setVoice={setVoice} />));
    expect(choice()?.props.options.find((option: { id: string }) => option.id === 'agent').unavailableReason).toBeUndefined();
    act(() => choice()?.props.onChange('agent'));
    expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]?.[0]).conversationMode).toBe('agent');
  });
  it('says once why a Voice agent is unavailable, beside the action that turns it on', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    storage.getState().applySettingsLocal({ featureToggles: { 'voice.agent': false, 'execution.runs': true } });
    const screen = await renderSettingsView(<LocalConversationSection voice={createLocalConversationVoice({ conversationMode: 'direct_session' })} setVoice={vi.fn()} />);
    expect(screen.findByTestId('settings.voice.local.turnOnVoiceAgent')).toBeTruthy();
    const reason = screen.findAll((node) => node.props?.title === t('settingsFeatures.expVoiceAgent') && typeof node.props?.subtitle === 'string')[0]?.props.subtitle as string;
    expect(reason).toBeTruthy();
    const reasonTexts = screen.tree.findAll((node) => typeof node.type === 'string'
      && node.children.some((child) => typeof child === 'string' && child.includes(reason)));
    expect(reasonTexts).toHaveLength(1);
    const agentOption = findSegmentedChoiceByTitle(screen, t('settingsVoice.pages.conversations.talkToTitle'))
      ?.props.options.find((option: { id: string }) => option.id === 'agent');
    expect(agentOption?.disabled).toBe(true);
  });
  it.each(['sticky', 'replacement', 'unavailable'] as const)('keeps the %s execution target for Agent identities and models', async (kind) => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: {
      agentSource: 'agent', agentId: 'com.a.voice.agent', chatModelSource: 'custom',
      ...(kind === 'replacement' ? { machineTargetMode: 'fixed', machineTargetId: 'old-a' }
        : { autoTargetMachineId: 'a' }),
    } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, storage.getState().settings));
    if (kind !== 'replacement') useVoiceTargetStore.getState().rememberAutoTargetMachine(storage.getState().settingsScope!, 'a');
    expect(storage.getState().settings.voice.executionMachine).toEqual(voice.executionMachine);
    storage.setState({ machines: {
      a: createMachineFixture({ id: 'a', active: kind !== 'unavailable', activeAt: kind === 'unavailable' ? 1 : Date.now() }),
      b: createMachineFixture({ id: 'b', activeAt: Date.now() }),
      ...(kind === 'replacement' ? { 'old-a': createMachineFixture({ id: 'old-a', active: false, replacedByMachineId: 'a' }) } : {}),
    } });
    await publishMachineCensus();
    storage.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'b', path: '/recent' }] });
    registryDescribe.mockImplementation(async (machineId) => ({ supported: true, projection: PluginProjectionV2Schema.parse({
      v: 2, generation: machineId === 'a' ? 10 : 20, familiesById: {},
      agentsById: { [`com.${machineId}.voice.agent`]: { id: `com.${machineId}.voice.agent`,
        identity: { pluginId: `com.${machineId}.voice`, localId: 'agent' }, title: `Agent ${machineId}`,
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      } },
    }) }));
    capabilitiesInvoke.mockImplementation(async (machineId) => ({ supported: true, response: { ok: true, result: {
      availableModels: [{ id: `model-${machineId}`, name: `Model ${machineId}` }], supportsFreeform: true,
    } } }));
    const setVoice = vi.fn();
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const picker = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'));
    const models = findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.chatModelId.title'));
    if (kind === 'unavailable') {
      expect(picker?.props.selectedId).toBe('com.a.voice.agent');
      expect(picker?.props.items.some((item: { id: string }) => item.id === 'com.b.voice.agent')).toBe(false);
      expect(capabilitiesInvoke).not.toHaveBeenCalled();
      expect(setVoice).not.toHaveBeenCalled();
    } else {
      await waitForTestEvent(screen.subscribe, () => picker?.props.items, items => items?.some((item: { id: string }) => item.id === 'agent:com.a.voice/agent') === true);
      expect(picker?.props.items.map((item: { id: string }) => item.id)).toContain('agent:com.a.voice/agent');
      await waitForTestEvent(screen.subscribe, () => models?.props.items, items => items?.some((item: { id: string }) => item.id === 'model-a') === true);
      expect(models?.props.items.map((item: { id: string }) => item.id)).toContain('model-a');
      act(() => picker?.props.onSelect('agent:com.a.voice/agent'));
      expect(readLocalConversationVoiceSettings(setVoice.mock.calls[0]?.[0]).agent).toMatchObject({
        agentIdentity: { pluginId: 'com.a.voice', localId: 'agent' },
      });
    }
  });
  it('reveals the requested custom Agent editor without changing the selected Agent', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'com.acme.voice.agent',
        agentTargetKey: 'agent:com.acme.voice/agent',
        agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
      },
    });
    const render = () => <LocalConversationSection voice={voice} setVoice={setVoice} />;
    const screen = await renderSettingsView(render());
    expect(screen.findAll((node) => node.props.fieldTestID === 'settings.voice.local.agentId.custom.field')).toHaveLength(0);

    routeParams.value = { setting: VOICE_CONVERSATIONS_SETTINGS.settings.customAgent.anchor };
    await act(async () => screen.update(render()));

    const field = screen.findAll((node) => node.props.fieldTestID === 'settings.voice.local.agentId.custom.field')[0];
    expect(field).toBeDefined();
    expect(field?.props.value).toBe('com.acme.voice.agent');
    expect(screen.findAllByProps({ nativeID: `setting-${VOICE_CONVERSATIONS_SETTINGS.settings.customAgent.anchor}` }).length).toBeGreaterThan(0);
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('does not select a fixed Agent to reveal a custom Agent request', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    routeParams.value = { setting: VOICE_CONVERSATIONS_SETTINGS.settings.customAgent.anchor };
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: { agentSource: 'session' } });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    expect(screen.findAll((node) => node.props.fieldTestID === 'settings.voice.local.agentId.custom.field')).toHaveLength(0);
    expect(setVoice).not.toHaveBeenCalled();
  });

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
    const findExternalEntry = () => agentPicker?.props.items.find(
      (item: DropdownMenuItem) => item.id === 'agent:com.acme.voice/agent',
    );
    await waitForTestEvent(screen.subscribe, findExternalEntry, entry => entry !== undefined);
    expect(findExternalEntry()).toMatchObject({
      id: 'agent:com.acme.voice/agent',
      title: 'Acme Voice',
      subtitle: 'External conversation Agent',
    });
    const externalEntry = findExternalEntry();
    expect(externalEntry.icon.props.entry).toMatchObject({
      qualifiedId: 'com.acme.voice.agent',
      identity: { pluginId: 'com.acme.voice', localId: 'agent' },
      projectionGeneration: 7,
      isBuiltIn: false,
    });

    expect(agentPicker?.props.items.map((item: DropdownMenuItem) => item.id)).toContain('__custom__');

    act(() => {
      agentPicker?.props.onSelect('agent:com.acme.voice/agent');
    });

    const nextVoice = setVoice.mock.calls[0]?.[0] as VoiceSettings;
    expect(readLocalConversationVoiceSettings(nextVoice).agent.agentId).toBe('com.acme.voice.agent');
    expect(readLocalConversationVoiceSettings(nextVoice).agent).toMatchObject({
      agentTargetKey: 'agent:com.acme.voice/agent',
      agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
    });
    await expect(resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: readLocalConversationVoiceSettings(nextVoice).agent,
    })).resolves.toMatchObject({
      ok: true,
      agentId: 'com.acme.voice.agent',
      backendTarget: { kind: 'backend', backendId: 'com.acme.voice.agent' },
      targetKey: 'agent:com.acme.voice/agent',
    });

    clearDaemonMergedProjectionCacheForTests();
    registryDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    await expect(resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: readLocalConversationVoiceSettings(nextVoice).agent,
    })).resolves.toMatchObject({ ok: false, errorCode: 'voice_agent_selection_unavailable' });
  });

  it('persists the exact backend target key of a bundled Agent selection', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'com.acme.voice.agent',
        agentTargetKey: 'agent:com.acme.voice/agent',
        agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
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
      agentTargetKey: 'agent:happier.agent.codex/codex',
      agentIdentity: null,
    });
    await expect(resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: readLocalConversationVoiceSettings(nextVoice).agent,
    })).resolves.toMatchObject({
      ok: true,
      agentId: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex' },
    });
  });

  it('clears the previous catalog identity when committing a changed custom Agent id', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'com.acme.voice.agent',
        agentTargetKey: 'agent:com.acme.voice/agent',
        agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
      },
    });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    act(() => {
      findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'))?.props.onSelect('__custom__');
    });
    const field = screen.findAll((node) => node.props?.fieldTestID === 'settings.voice.local.agentId.custom.field')[0];
    expect(field).toBeDefined();
    act(() => { field.props.onCommit('claude'); });

    const selection = readLocalConversationVoiceSettings(setVoice.mock.calls[0]?.[0]).agent;
    expect(selection).toMatchObject({
      agentId: 'claude',
      agentTargetKey: null,
      agentIdentity: null,
    });
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: 'machine-1', selection })).resolves.toMatchObject({
      ok: true,
      agentId: 'claude',
      backendTarget: { kind: 'backend', backendId: 'claude' },
    });
  });

  it('does not offer an external Agent from a retained non-current projection', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: { agentSource: 'agent' },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const refresh = createDeferred<Awaited<ReturnType<typeof registryDescribe>>>();
    registryDescribe.mockImplementationOnce(() => refresh.promise);
    await act(async () => {
      publishMachineContributionRegistryProjectionInvalidation({
        machineId: 'machine-1', serverId: getActiveServerSnapshot().serverId,
      });
    });
    const agentPicker = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.mediatorAgentId'),
    );

    expect(agentPicker?.props.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'com.acme.voice.agent' }),
    ]));
    await act(async () => { refresh.resolve({ supported: false, reason: 'not-supported' }); });
  });

  it('preserves exact catalog facts when a custom commit leaves the normalized Agent id unchanged', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'com.acme.voice.agent',
        agentTargetKey: 'agent:com.acme.voice/agent',
        agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
      },
    });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    act(() => {
      findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.mediatorAgentId'))?.props.onSelect('__custom__');
    });
    const field = screen.findAll((node) => node.props?.fieldTestID === 'settings.voice.local.agentId.custom.field')[0];
    act(() => { field.props.onCommit('  com.acme.voice.agent  '); });
    expect(setVoice).not.toHaveBeenCalled();
    expect(readLocalConversationVoiceSettings(voice).agent).toMatchObject({
      agentId: 'com.acme.voice.agent',
      agentTargetKey: 'agent:com.acme.voice/agent',
      agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
    });
  });

  it('does not expose the retired Voice-owned Chat endpoint or credential controls', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const ItemComponent = Reflect.get(Item, 'type') ?? Item;
    expect(screen.findAll((node) => node.type === ItemComponent && node.props?.title === t('settingsVoice.local.chatBaseUrl'))).toHaveLength(0);
    expect(screen.findAll((node) => node.type === ItemComponent && node.props?.title === t('settingsVoice.local.chatApiKey'))).toHaveLength(0);
  });

  it('asks once for the compatible Agent and commits both Provider tuples together', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const changed = createDeferred<void>();
    const setVoice = vi.fn<(voice: VoiceSettings) => void>(() => { changed.resolve(); });
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentId: 'com.acme.voice.agent',
        agentTargetKey: 'agent:com.acme.voice/agent',
        agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
        providerChat: {
          status: 'needs_selection',
          providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
          chatModelId: 'qwen-chat',
          commitModelId: 'qwen-commit',
        },
      },
    });
    const agentTargetKey = 'agent:happier.agent.opencode/opencode';
    const connectionId = 'voice-openai-compatible-chat';
    providerTransport.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
      createProviderModelProjectionFixture({ agentTargetKey, groups: [createProviderModelProjectionGroupFixture({ connectionId,
        rows: ['qwen-chat', 'qwen-commit'].map(modelId => ({
          ref: { agentTargetKey, providerConnectionId: connectionId, modelId },
          descriptor: { id: modelId, name: modelId },
          sources: { manual: true, static: false, probe: false }, confidence: 'manual',
          compatibility: { result: { status: 'experimental', selectedProtocol: 'openai-chat',
            reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId } },
            compatibilityFingerprint: 'compatibility:v1:voice-chat', confirmed: true },
          endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
        })),
      })] }));

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const prompts = screen.findAll((node) => (
      node.type === DropdownMenu
      && node.props?.itemTrigger?.title === t('settingsVoice.local.mediatorAgentId')
      && node.props?.selectedId === ''
    ));
    expect(prompts).toHaveLength(1);
    await waitForTestEvent(providerTransport.subscribe, () => providerTransport.state.requests,
      requests => requests.some(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION));
    expect(providerTransport.state.requests.some(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true);
    await act(async () => {
      prompts[0]!.props.onSelect('opencode');
    });
    await changed.promise;
    expect(setVoice).toHaveBeenCalled();
    const nextVoice = setVoice.mock.calls[0]?.[0] as VoiceSettings;
    expect(readLocalConversationVoiceSettings(nextVoice).agent).toMatchObject({
      agentSource: 'agent',
      agentId: 'opencode',
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      agentIdentity: null,
      providerChat: {
        status: 'configured',
        chat: {
          agentTargetKey: 'agent:happier.agent.opencode/opencode',
          providerConnectionId: 'voice-openai-compatible-chat',
          modelId: 'qwen-chat',
        },
        commit: {
          agentTargetKey: 'agent:happier.agent.opencode/opencode',
          providerConnectionId: 'voice-openai-compatible-chat',
          modelId: 'qwen-commit',
        },
      },
    });
    await screen.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />);
    expect(screen.findAll((node) => (
      node.type === DropdownMenu
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
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
            modelId: 'provider-chat-model',
          },
          commit: {
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
            modelId: 'provider-commit-model',
          },
        },
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    openAdvancedAgent(screen);
    for (const title of [
      t('settingsVoice.local.mediatorAgentSource'),
      t('settingsVoice.local.mediatorAgentId'),
      t('settingsVoice.local.mediatorChatModelSource'),
      t('settingsVoice.local.conversation.chatModelId.title'),
      t('settingsVoice.local.mediatorCommitModelSource'),
      t('settingsVoice.local.conversation.commitModelId.title'),
    ]) {
      expect(findChoiceByTitle(screen, title)).toBeNull();
    }

    expect(findSegmentedChoiceByTitle(
      screen,
      t('settingsVoice.pages.conversations.itMayTitle'),
    )).not.toBeNull();
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeTruthy();
    expect(screen.findRowByTitle(t('settingsVoice.local.mediatorIdleTtl'))).toBeTruthy();
    expect(capabilitiesInvoke).not.toHaveBeenCalled();

    for (const id of ['agentSource', 'agent', 'customAgent', 'chatModelSource', 'chatModelId', 'commitModelSource', 'commitModelId'] as const) {
      const setting = VOICE_CONVERSATIONS_SETTINGS.settings[id];
      routeParams.value = { setting: setting.anchor };
      await screen.update(<LocalConversationSection voice={voice} setVoice={() => {}} />);
      const prerequisite = screen.findAllHostsByTestId('settings.voice.searchPrerequisite');
      expect(prerequisite, `Search must explain the absent ${id} row`).toHaveLength(1);
      expect(screen.findRowByTitle(t(setting.titleKey))?.props.subtitle).toEqual(expect.any(String));
      expect(screen.findAll((node) => typeof node.type === 'string' && node.props.nativeID === `setting-${setting.anchor}`)).toHaveLength(1);
    }

    const cfg = readLocalConversationVoiceSettings(voice);
    const withoutProviderChat = writeLocalConversationVoiceSettings(voice, { ...cfg, agent: { ...cfg.agent, providerChat: null } });
    routeParams.value = { setting: VOICE_CONVERSATIONS_SETTINGS.settings.chatModelId.anchor };
    await screen.update(<LocalConversationSection voice={withoutProviderChat} setVoice={() => {}} />);
    expect(findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.chatModelId.title'))).not.toBeNull();
    expect(screen.findAllHostsByTestId('settings.voice.searchPrerequisite')).toHaveLength(0);
  });

  it.each([
    { id: 'agentSource', overrides: { conversationMode: 'direct_session' } },
    { id: 'customAgent', overrides: { conversationMode: 'agent', agent: { agentSource: 'session' } } },
    { id: 'chatModelId', overrides: { conversationMode: 'agent', agent: { chatModelSource: 'session' } } },
    { id: 'commitModelId', overrides: { conversationMode: 'agent', agent: { commitModelSource: 'chat' } } },
    { id: 'maxWarmRoots', overrides: { conversationMode: 'agent', agent: { rootSessionPolicy: 'single' } } },
    { id: 'silenceMs', overrides: { handsFree: { ...readLocalConversationVoiceSettings(voiceSettingsDefaults).handsFree, enabled: false } } },
    { id: 'sttLanguage', overrides: { stt: { ...readLocalConversationVoiceSettings(voiceSettingsDefaults).stt, provider: 'device' } } },
    { id: 'ttsVoiceId', overrides: { tts: { ...readLocalConversationVoiceSettings(voiceSettingsDefaults).tts, provider: 'device' } } },
  ] satisfies readonly { id: keyof typeof VOICE_CONVERSATIONS_SETTINGS.settings; overrides: LocalConversationAdapterOverrides }[])(
    'explains a hidden $id at its rendered owner when search requests it', async ({ id, overrides }) => {
      const LocalConversationSection = await loadLocalConversationSection();
      const setting = VOICE_CONVERSATIONS_SETTINGS.settings[id];
      routeParams.value = { setting: setting.anchor };
      const screen = await renderSettingsView(<LocalConversationSection voice={createLocalConversationVoice(overrides)} setVoice={() => {}} />);
      const prerequisite = screen.findAllHostsByTestId('settings.voice.searchPrerequisite');
      expect(prerequisite).toHaveLength(1);
      expect(screen.findRowByTitle(t(setting.titleKey))?.props.subtitle).toEqual(expect.any(String));
      expect(screen.findAll((node) => typeof node.type === 'string' && node.props.nativeID === `setting-${setting.anchor}`)).toHaveLength(1);
    },
  );

  it('does not probe a substitute Agent for The session when no Session target is admitted', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'session',
        agentId: 'codex',
        machineTargetMode: 'fixed',
        machineTargetId: 'machine-1',
        chatModelSource: 'custom',
        chatModelId: 'saved-model',
        commitModelSource: 'custom',
        commitModelId: 'saved-commit',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={() => {}} />);
    const chatModel = findDropdownByItemTriggerTitle(
      screen,
      t('settingsVoice.local.conversation.chatModelId.title'),
    );

    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
    expect(capabilitiesInvoke.mock.calls.filter(([, request]) => request.method === 'probeModels')).toEqual([]);
    expect(chatModel?.props.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'm1' })]));
    expect(chatModel?.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: '__custom__' })]));
    expect(chatModel?.props.selectedId).toBe('saved-model');
    openAdvancedAgent(screen);
    expect(findDropdownByItemTriggerTitle(screen, t('settingsVoice.local.conversation.commitModelId.title'))?.props.selectedId)
      .toBe('saved-commit');
  });

  it('does not crash when providerId toggles away from local_conversation', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = () => {};
    const initialVoice = createLocalConversationVoice({ conversationMode: 'agent', agent: { agentSource: 'agent', agentId: 'codex' } });
    const nextVoice = withProvider(voiceSettingsDefaults, 'off');

    const screen = await renderSettingsView(<LocalConversationSection voice={initialVoice} setVoice={setVoice} />);

    await openDropdown(screen, t('settingsVoice.local.mediatorAgentId'));
    await expect(screen.update(<LocalConversationSection voice={nextVoice} setVoice={setVoice} />)).resolves.toBeUndefined();
    expect(screen.findAllByType(DropdownMenu)).toHaveLength(0);
    expect(screen.findAll(node => typeof node.type === 'string'
      && typeof node.props.testID === 'string' && node.props.testID.startsWith('dropdown-option-'))).toHaveLength(0);
  });

  it('renders the local section on web only when local remains the stored provider', async () => {
    platformOsMock.value = 'web';
    const LocalConversationSection = await loadLocalConversationSection();
    const localVoice = createLocalConversationVoice();

    const screen = await renderSettingsView(<LocalConversationSection voice={localVoice} setVoice={() => {}} />);

    expect(findSegmentedChoiceByTitle(screen, t('settingsVoice.pages.conversations.talkToTitle'))).toBeTruthy();

    await screen.update(
        <LocalConversationSection
          voice={withProvider(localVoice, 'happier.voice.elevenlabs/realtime-elevenlabs')}
          setVoice={() => {}}
        />,
      );

    expect(findChoiceByTitle(screen, t('settingsVoice.pages.conversations.talkToTitle'))).toBeFalsy();
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
    expect(backendDropdown?.props.selectedId).toBe('agent:happier.agent.codex/codex');
  });

  it('offers only the selected Voice Agent services and saves its qualified pool choice', async () => {
    registryDescribe.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({
      v: 2, generation: 7, familiesById: {}, agentsById: {
        'com.acme.voice.agent': {
          id: 'com.acme.voice.agent', identity: { pluginId: 'com.acme.voice', localId: 'agent' },
          title: 'Acme Voice', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }],
        },
      },
    }) });
    const LocalConversationSection = await loadLocalConversationSection();
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({ conversationMode: 'agent', agent: {
      agentSource: 'agent', agentId: 'com.acme.voice.agent', agentTargetKey: 'agent:com.acme.voice/agent',
      agentIdentity: { pluginId: 'com.acme.voice', localId: 'agent' },
    } });
    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    const { VoiceGlobalConnectedServicesBindingField } = await import('./realtime/VoiceGlobalConnectedServicesBindingField');
    await waitForTestEvent(screen.subscribe,
      () => screen.tree.findByType(VoiceGlobalConnectedServicesBindingField).props.serviceIds,
      serviceIds => serviceIds.length === 1);
    const accounts = screen.tree.findByType(VoiceGlobalConnectedServicesBindingField);
    expect(accounts.props.serviceIds).toEqual(['happier.agent.codex/openai-codex']);
    expect(accounts.props.bindingVersion).toBe(2);
    const connectedServices = { v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'voice-pool' },
    } };
    await act(async () => accounts.props.onChange(connectedServices, null));
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent.connectedServices).toEqual(connectedServices);
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
        .filter((item: DropdownMenuItem) => ['__refresh_models__', 'm1', '__custom__'].includes(String(item?.id)))
        .map((item: DropdownMenuItem) => [String(item.id), React.isValidElement(item.icon) ? item.icon.type : null]),
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
    openAdvancedAgent(screen);
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

    await capabilitiesCompleted.promise;
    expect(capabilitiesInvoke).toHaveBeenCalledWith('machine-1', expect.objectContaining({
      params: expect.objectContaining({ backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' } }),
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

    await capabilitiesCompleted.promise;
    expect(capabilitiesInvoke.mock.calls.map(([machineId]) => machineId)).toEqual(['machine-1']);
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

    await capabilitiesCompleted.promise;
    expect(capabilitiesInvoke.mock.calls.map(([machineId]) => machineId)).toEqual(['machine-1']);
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
    openAdvancedAgent(screen);
    const switchTitles = [
      t('settingsVoice.local.conversation.handsFree.enableTitle'),
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
    openAdvancedAgent(screen);
    const policyChoice = findSegmentedChoiceByTitle(screen, t('settingsVoice.local.conversation.rootSessionPolicy.title'));
    expect(policyChoice?.props.value).toBe('keep_warm');
    expect(policyChoice?.props.options.map((option: { id: string }) => option.id)).toEqual(['single', 'keep_warm']);
  });

  it('hides Agent-only commit isolation when voice.agent is disabled', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    storage.getState().applySettingsLocal({ featureToggles: { 'voice.agent': false, 'execution.runs': true } });
    const setVoice = vi.fn();
    const voice = createLocalConversationVoice({
      conversationMode: 'agent',
      agent: {
        agentSource: 'agent',
        agentId: 'codex',
      },
    });

    const screen = await renderSettingsView(<LocalConversationSection voice={voice} setVoice={setVoice} />);
    openAdvancedAgent(screen);
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
    openAdvancedAgent(screen);
    expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeTruthy();
  });
  it('offers hands-free for every endpoint-driven recognizer and keeps it visible, locked, for a batch recognizer', async () => {
    const LocalConversationSection = await loadLocalConversationSection();
    const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const handsFreeTitle = t('settingsVoice.local.conversation.handsFree.enableTitle');

    const neural = await renderSettingsView(<LocalConversationSection
      voice={createLocalConversationVoice({ stt: { ...defaults.stt, provider: 'local_neural' } })}
      setVoice={() => {}}
    />);
    const neuralRow = neural.findRowByTitle(handsFreeTitle);
    expect(neuralRow).toBeTruthy();
    expect(neuralRow?.props.rightElement?.props.disabled).not.toBe(true);

    const batch = await renderSettingsView(<LocalConversationSection
      voice={createLocalConversationVoice({ stt: { ...defaults.stt, provider: 'happier.voice.openai-compat/stt' } })}
      setVoice={() => {}}
    />);
    const batchRow = batch.findRowByTitle(handsFreeTitle);
    expect(batchRow).toBeTruthy();
    expect(batchRow?.props.rightElement?.props.disabled).toBe(true);
    expect(typeof batchRow?.props.subtitle).toBe('string');
  });

});
