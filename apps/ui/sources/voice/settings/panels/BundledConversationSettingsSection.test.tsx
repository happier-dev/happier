import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { Modal } from '@/modal';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { upsertAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { VoiceCredentialSourceField } from './realtime/VoiceCredentialSourceField';
import { BundledConversationSettingsSection } from './BundledConversationSettingsSection';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness } from './voiceSettingsAccountTestHarness';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
    key === 'settingsVoice.realtimeProviders.operationFailedStage' ? `${key}(stage=${String(params?.stage)})` : key });
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vi.fn() } }));
await loadSyncSingletonForTests();

const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
const openAiProviderId = 'happier.voice.openai/realtime-openai';
const contribution = { pluginId: 'happier.voice.elevenlabs', localId: 'realtime-elevenlabs' };
// React Test Renderer exposes the function inside a simple React.memo wrapper.
const CredentialComponent = Reflect.get(VoiceCredentialItem, 'type') as React.ComponentType<React.ComponentProps<typeof VoiceCredentialItem>>;
const GroupComponent = Reflect.get(ItemGroup, 'type') as React.ComponentType<React.ComponentProps<typeof ItemGroup>>;
function voiceWith(patch: Readonly<Record<string, unknown>> = {}): VoiceSettings {
  return voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: 2,
    config: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode: 'byo', ...patch },
  } } });
}

describe('BundledConversationSettingsSection', () => {
  let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
  let provider: ReturnType<typeof createElevenLabsSettingsRuntimeTestHarness>;
  const disposals: Array<() => void | Promise<void>> = [];
  const initialStorage = storage.getState();
  beforeEach(async () => {
    vi.clearAllMocks();
    provider = createElevenLabsSettingsRuntimeTestHarness();
    provider.register();
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ voiceSettingsV1: voiceWith() }));
  });
  afterEach(async () => {
    while (disposals.length) await disposals.pop()?.();
    await act(async () => provider.dispose());
    await account?.dispose();
    storage.setState(initialStorage, true);
  });
  function saveCredential() {
    account.replaceSettings(upsertAccountVoiceCredential({ settings: account.settings, contribution,
      credentialSlotId: 'api_key', value: 'test-only-api-key', generateId: () => 'voice-test-secret', now: 1,
      expectedSecretId: null, expectedSecretUpdatedAt: null,
    }).settings);
  }
  async function render(voice = account.settings.voice, setVoice = vi.fn()) {
    return await renderScreen(<BundledConversationSettingsSection voice={voice} setVoice={setVoice} />);
  }
  function config() { return account.settings.voice.providers[providerId]?.config; }

  it('places credentials and provisioning, output voice, and greeting in their contributed groups', async () => {
    const screen = await render();
    const groups = screen.tree.findAllByType(GroupComponent);
    const accountGroup = groups.find((group) => group.findAllByType(CredentialComponent).length > 0);
    const voiceGroup = groups.find((group) => group.findAllByProps({ testID: 'voice-realtime-field-tts-voiceId' }).length > 0);
    const isGreeting = (node: { props: Record<string, unknown> }) => node.props.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props.options);
    const conversationGroup = groups.find((group) => group.findAll(isGreeting).length > 0);
    expect(accountGroup?.findAllByType(CredentialComponent)).toHaveLength(1);
    expect(accountGroup?.findAllByProps({ testID: 'voice-settings-action-create-agent' }).length).toBeGreaterThan(0);
    expect(voiceGroup?.findAllByType(CredentialComponent)).toHaveLength(0);
    expect(conversationGroup?.findAll(isGreeting).length).toBeGreaterThan(0);
    expect(accountGroup?.findAll(isGreeting)).toHaveLength(0);
  });

  async function registerOpenAiSources(connectedOnly: boolean) {
    const base = createDefaultVoiceProviderRegistry().get(openAiProviderId);
    if (base?.kind !== 'voice.conversation-provider.v1' || base.declaration?.kind !== 'conversation' || !base.declaration.credentials) throw new Error('OpenAI conversation declaration missing');
    const sources = connectedOnly ? base.declaration.credentials.sources.filter((source) => source.kind === 'connectedAccount') : base.declaration.credentials.sources;
    const descriptor = { ...base, declaration: { ...base.declaration, credentials: { ...base.declaration.credentials, sources } } };
    const token = Object.freeze({});
    commitExternalVoiceProviderRegistration({ token, pluginId: base.pluginId, localId: base.declaration.id, providerId: openAiProviderId, descriptor, adapter: null });
    disposals.push(() => removeExternalVoiceProviderRegistration(token));
    return await render(voiceSettingsParse({ providerId: openAiProviderId }));
  }
  it('renders only the canonical source selector for a Connected Account-only conversation', async () => {
    const screen = await registerOpenAiSources(true);
    expect(screen.tree.findAllByType(VoiceCredentialSourceField)).toHaveLength(1);
    expect(screen.tree.findAllByType(CredentialComponent)).toHaveLength(0);
  });
  it('routes an unresolved multi-source conversation SavedSecret edit through the atomic source owner', async () => {
    const screen = await registerOpenAiSources(false);
    expect(screen.tree.findByType(CredentialComponent).props).toMatchObject({ credentialSlotId: 'api_key', credentialSourcePurpose: 'voice.client-auth' });
  });
  it('renders no realtime-provider error panel when the selected provider is off or local', async () => {
    for (const selected of [null, 'local_conversation']) {
      const screen = await render(voiceSettingsParse({ providerId: selected }));
      expect(screen.tree.findAllByType(GroupComponent)).toHaveLength(0);
    }
  });
  it('reveals same-provider public settings actions when runtime registration arrives after render', async () => {
    removeExternalVoiceProviderRegistration(provider.registration.token);
    const screen = await render();
    expect(screen.tree.findAllByProps({ testID: 'voice-settings-action-create-agent' })).toHaveLength(0);
    await act(async () => provider.register());
    expect(screen.findByTestId('voice-settings-action-create-agent')).toBeTruthy();
  });
  it('allows opening the voice dropdown even when API key is not set', async () => {
    const screen = await render();
    const dropdown = screen.tree.findAllByType(DropdownMenu).find((node) => node.props.testID === 'voice-realtime-field-tts-voiceId');
    expect(dropdown?.props.itemTrigger.detailFormatter?.(null)).toBe('settingsVoice.realtimeProviders.catalog.credentialRequired');
    await act(async () => dropdown?.props.onOpenChange(true));
    expect(screen.tree.findAllByType(DropdownMenu).find((node) => node.props.testID === 'voice-realtime-field-tts-voiceId')?.props.open).toBe(true);
    expect(provider.request.mock.calls.some(([input]) => input.operationId === 'voices')).toBe(false);
  });
  it('projects a retained credential awaiting recipient approval as review-required in provider summaries', async () => {
    saveCredential();
    const base = createDefaultVoiceProviderRegistry().get(providerId);
    const slot = base?.accountCredentialSlot;
    if (!base || !slot?.recipientContract) throw new Error('Recipient contract missing');
    const contract = { ...slot.recipientContract, package: { ...slot.recipientContract.package, source: { kind: 'package' as const, locator: 'test-elevenlabs-package' } },
      publisher: { trust: 'verified' as const, identity: 'test-publisher' } };
    const { createRecipientContractDigestV1 } = await import('@happier-dev/protocol');
    commitExternalVoiceProviderRegistration({ ...provider.registration, descriptor: { ...base, accountCredentialSlot: { ...slot,
      recipientContract: contract, recipientContractDigest: createRecipientContractDigestV1(contract) } } });
    const screen = await render();
    const dropdown = screen.tree.findAllByType(DropdownMenu).find((node) => node.props.testID === 'voice-realtime-field-tts-voiceId');
    expect(dropdown?.props.itemTrigger.detailFormatter?.(null)).toBe('settingsVoice.externalCredentials.reviewRequired');
    expect(account.settings.secrets).toHaveLength(1);
    expect(provider.request.mock.calls.some(([input]) => input.operationId === 'voices')).toBe(false);
  });
  it('keeps credential deletion in the canonical credential item instead of rendering a competing disconnect action', async () => {
    saveCredential();
    const screen = await render();
    expect(screen.tree.findAllByProps({ title: 'settingsVoice.realtimeProviders.disconnect.title' })).toHaveLength(0);
    expect(screen.tree.findAllByType(CredentialComponent)).toHaveLength(1);
  });
  it('binds client BYOK to account SavedSecrets and requires plaintext-mode disclosure', async () => {
    const screen = await render();
    const credential = screen.tree.findByType(CredentialComponent);
    expect(credential.props).toMatchObject({ credentialSlotId: 'api_key', credentialSourcePurpose: 'voice.client-auth.elevenlabs', disclosePlainStorage: true });
    expect(credential.props).not.toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
    vi.mocked(Modal.prompt).mockResolvedValue('test-only-entered-key');
    vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
    const enterNew = () => credential.findAll((node) => node.props.title === 'settingsVoice.byo.apiKeyTitle'
      && typeof node.props.onPress === 'function')[0]!.props.onPress();
    await act(async () => enterNew());
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledWith(
      'settingsVoice.local.voiceCredential.plainStorageTitle',
      'settingsVoice.local.voiceCredential.plainStorageBody', expect.anything(),
    ));
    expect(account.settings.secrets).toHaveLength(0);
    expect(account.writes).toHaveLength(0);
    await act(async () => enterNew());
    await vi.waitFor(() => expect(account.settings.secrets).toHaveLength(1));
    expect(account.writes).toHaveLength(1);
    expect(account.persistedSettings.secrets).toHaveLength(1);
    expect(account.settings.voice.providers[providerId]?.config).not.toHaveProperty('apiKey');
    expect(account.persistedSettings.voice.providers[providerId]?.config).not.toHaveProperty('apiKey');
  });
  it('wires welcome message selection into settings', async () => {
    const setVoice = vi.fn();
    const screen = await render(account.settings.voice, setVoice);
    const greeting = screen.tree.findAll((node) => node.props.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props.options))[0];
    expect(greeting).toBeTruthy();
    await act(async () => greeting?.props.onChange('off'));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ welcome: expect.objectContaining({ enabled: false }) }));
  });
  it('reports a bounded provisioning failure stage without persisting an unverified agent id', async () => {
    saveCredential();
    const originalRequest = provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async (input) => input.operationId === 'create-tool'
      ? provider.response({ providerPrivateValue: 'must-not-reach-alert' }, 400) : originalRequest(input));
    const screen = await render();
    await screen.pressByTestIdAsync('voice-settings-action-create-agent');
    await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith('common.error',
      'settingsVoice.realtimeProviders.operationFailedUnsaved\n\nsettingsVoice.realtimeProviders.operationFailedStage(stage=create_tool)'));
    expect(config()).toMatchObject({ agentId: '' });
    expect(account.writes).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(Modal.alertAsync).mock.calls)).not.toContain('must-not-reach-alert');
  });
  it('keeps client-executed autoprovision independent of daemon selection changes', async () => {
    saveCredential();
    const existing = createDeferred<Awaited<ReturnType<typeof provider.request>>>();
    const originalRequest = provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async (input) => input.operationId === 'agents' ? existing.promise : originalRequest(input));
    const screen = await render();
    await screen.pressByTestIdAsync('voice-settings-action-create-agent');
    await vi.waitFor(() => expect(provider.request.mock.calls.some(([input]) => input.operationId === 'agents')).toBe(true));
    const next = voiceSettingsParse({ ...account.settings.voice, executionMachine: { kind: 'machine', machineId: 'machine-b' } });
    account.replaceVoice(next);
    await screen.update(<BundledConversationSettingsSection voice={next} setVoice={vi.fn()} />);
    await act(async () => existing.resolve(provider.response({ agents: [], has_more: false, next_cursor: null })));
    await vi.waitFor(() => expect(config()).toMatchObject({ agentId: 'agent_created' }));
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: 'agent_created' });
  });
  it('aborts a deferred autoprovision when its provider target retires without publishing stale work', async () => {
    saveCredential();
    const existing = createDeferred<Awaited<ReturnType<typeof provider.request>>>();
    let signal: AbortSignal | undefined;
    const originalRequest = provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async (input) => {
      if (input.operationId !== 'agents') return originalRequest(input);
      signal = input.signal;
      return existing.promise;
    });
    const screen = await render();
    await screen.pressByTestIdAsync('voice-settings-action-create-agent');
    await vi.waitFor(() => expect(signal).toBeDefined());
    const next = voiceSettingsParse({ ...account.settings.voice, providerId: null });
    account.replaceVoice(next);
    await screen.update(<BundledConversationSettingsSection voice={next} setVoice={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => existing.resolve(provider.response({ agents: [], has_more: false, next_cursor: null })));
    expect(provider.request.mock.calls.some(([input]) => input.operationId === 'create-agent')).toBe(false);
    expect(account.writes).toHaveLength(0);
  });
  it('does not let a stale legacy-secret scrub overwrite newer canonical provider settings', async () => {
    const setVoice = vi.fn();
    const legacy = voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: 1, config: {
      billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: { _isSecretValue: true, value: 'legacy-key' } },
      tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
    } } } });
    const screen = await render(legacy, setVoice);
    const latest = voiceWith({ agentId: 'agent-new' });
    account.replaceVoice(latest);
    await screen.update(<BundledConversationSettingsSection voice={latest} setVoice={setVoice} />);
    expect(setVoice).not.toHaveBeenCalled();
    expect(account.writes).toHaveLength(0);
    expect(config()).toMatchObject({ agentId: 'agent-new' });
  });
  it('merges a completed settings action into the latest canonical same-provider config', async () => {
    saveCredential();
    const created = createDeferred<Awaited<ReturnType<typeof provider.request>>>();
    const originalRequest = provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async (input) => input.operationId === 'create-agent' ? created.promise : originalRequest(input));
    const screen = await render();
    await screen.pressByTestIdAsync('voice-settings-action-create-agent');
    await vi.waitFor(() => expect(provider.request.mock.calls.some(([input]) => input.operationId === 'create-agent')).toBe(true));
    const next = voiceWith({ tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, voiceId: 'voice-new' } });
    account.replaceVoice(next);
    await act(async () => created.resolve(provider.response({ agent_id: 'agent-new' })));
    await vi.waitFor(() => expect(config()).toMatchObject({ agentId: 'agent-new', tts: { voiceId: 'voice-new' } }));
    expect(account.writes).toHaveLength(1);
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: 'agent-new', tts: { voiceId: 'voice-new' } });
  });
  it('fails closed instead of treating secret-shaped canonical data as a legacy import source', async () => {
    const voice = voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: 2, config: {
      billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: { _isSecretValue: true, value: 'must-not-import' } },
    } } } });
    const screen = await render(voice);
    expect(screen.tree.findAllByType(CredentialComponent)).toHaveLength(0);
    expect(screen.tree.findAllByProps({ title: 'settingsVoice.realtimeProviders.unavailable.rowTitle' }).length).toBeGreaterThan(0);
    expect(account.settings.secrets).toHaveLength(0);
    expect(account.writes).toHaveLength(0);
  });
});
