import React from 'react';
import { Alert, Linking } from 'react-native';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ModalProvider } from '@/modal';
import { t, tLoose, setPreferredLanguageFromSettings } from '@/text';
import { WebPromptModal } from '@/modal/components/WebPromptModal';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { resolveVoiceWelcomeSelection } from '@/voice/settings/welcome';
import { storage } from '@/sync/domains/state/storage';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { getSavedSecretCatalogSnapshot, resolveSavedSecretReference, subscribeSavedSecretCatalogSnapshots } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { createRecipientContractDigestV1} from '@happier-dev/protocol/plugins/recipientContractV1';
import { deriveVoiceCredentialBindingIdentityV1} from '@happier-dev/protocol/plugins/contributions/voice';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { resolveAccountVoiceCredential, resolveAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { VoiceCredentialItem } from '@/voice/credentials/CredentialItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { OverlayPortalHost } from '@/components/ui/popover';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { getExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { getCurrentBundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import { BundledConversationSettingsSection } from './BundledConversationSettingsSection';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from './voiceSettingsAccountTestHarness';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' }, {
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vi.fn() } }));
await loadSyncSingletonForTests();
const nativeAlert = vi.spyOn(Alert, 'alert');
const alertListeners = new Set<() => void>();
async function waitForAlert(title: string) {
  await waitForTestEvent(notify => {
    alertListeners.add(notify);
    return () => { alertListeners.delete(notify); };
  }, () => nativeAlert.mock.calls.at(-1), call => call?.[0] === title);
  expect(nativeAlert.mock.calls.at(-1)?.[0]).toBe(title);
}
afterAll(() => nativeAlert.mockRestore());
function ConversationProviders({ children }: React.PropsWithChildren) {
  return <ModalProvider>{children}</ModalProvider>;
}

const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
const openAiProviderId = 'happier.voice.openai/realtime-openai';
const contribution = { pluginId: 'happier.voice.elevenlabs', localId: 'realtime-elevenlabs' };
// React Test Renderer exposes the function inside a simple React.memo wrapper.
const CredentialComponent = Reflect.get(VoiceCredentialItem, 'type') as React.ComponentType<React.ComponentProps<typeof VoiceCredentialItem>>;
const GroupComponent = Reflect.get(ItemGroup, 'type') as React.ComponentType<React.ComponentProps<typeof ItemGroup>>;
function voiceWith(patch: Readonly<Record<string, unknown>> = {}): VoiceSettings {
  return voiceSettingsParse({ providerId, privacy: { currentUiContextMode: 'on_demand', shareDeviceInventory: true }, providers: { [providerId]: { schemaVersion: 2,
    config: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode: 'byo', ...patch },
  } } });
}
function matchesVendorRequest(input: Parameters<typeof globalThis.fetch>[0], init: RequestInit | undefined, method: string, pathname: string) {
  return (init?.method ?? 'GET') === method
    && new URL(input instanceof Request ? input.url : String(input)).pathname === pathname;
}

describe('BundledConversationSettingsSection', () => {
  let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
  let provider: ReturnType<typeof createElevenLabsSettingsRuntimeTestHarness>;
  const disposals: Array<() => void | Promise<void>> = [];
  const initialStorage = storage.getState();
  beforeEach(async () => {
    vi.clearAllMocks();
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ experiments: true, featureToggles: { voice: true }, voiceSettingsV1: voiceWith() }));
    provider = createElevenLabsSettingsRuntimeTestHarness();
    await provider.register();
    nativeAlert.mockReset();
    nativeAlert.mockImplementation(() => { for (const notify of alertListeners) notify(); });
    setPreferredLanguageFromSettings('en');
  });
  afterEach(async () => {
    standardCleanup();
    while (disposals.length) await disposals.pop()?.();
    await act(async () => provider.dispose());
    await account?.dispose();
    storage.setState(initialStorage, true);
  });
  async function saveCredential() {
    const recipient = createBundledVoiceRecipientContract({ pluginId: provider.entry.pluginId,
      declaration: provider.entry.declaration });
    if (!recipient) throw new Error('Expected ElevenLabs recipient contract');
    account.replaceSettings(await withVoiceSettingsCredentialResource(account, {
      settings: account.settings, declaration: provider.entry.declaration, pluginId: provider.entry.pluginId,
      resourceId: 'voice-test-secret', approvedRecipientContractDigest: createRecipientContractDigestV1(recipient),
    }));
    await refreshSavedSecretCatalog(account.scope);
    // Capture action authority from the real current material catalog.
    await waitForTestEvent(subscribeSavedSecretCatalogSnapshots,
      () => getSavedSecretCatalogSnapshot(account.scope),
      snapshot => snapshot?.status === 'ready' && !snapshot.stale && snapshot.legacyImport?.status === 'complete');
    expect(getSavedSecretCatalogSnapshot(account.scope)).toMatchObject({
      status: 'ready', stale: false, legacyImport: { status: 'complete' },
    });
    const reference = resolveAccountVoiceCredential(account.settings, contribution, 'api_key', null);
    expect(reference?.secretId).toMatch(/^happier:shared-secret:v1:/u);
    expect(resolveSavedSecretReference(account.scope, account.settings.secrets, reference?.secretId ?? ''))
      .toMatchObject({ status: 'ready', ref: reference?.secretId });
  }
  async function render(voice = account.settings.voice, content?: React.ReactElement) {
    return await renderScreen(content ?? <BundledConversationSettingsSection voice={voice} />, {
      wrapper: ConversationProviders,
      // The native SDK supplies physical view geometry; Popover measures and
      // chooses placement, portal ownership, and its render frame for real.
      createNodeMock: element => typeof element.type === 'string' ? ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(100, 120, 280, 48),
        focus: () => {},
      }) : null,
    });
  }
  function config() { return account.settings.voice.providers[providerId]?.config; }
  it('refuses a resource link before its OS effect when external-link Actions are disabled', async () => {
    const open = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const canOpen = vi.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    try {
      account.replaceSettings(settingsParse({ ...account.settings,
        actionsSettingsV1: { v: 1, actions: { 'links.openExternal': { enabled: false } } },
      }));
      const screen = await render();
      const resource = screen.tree.findAll(node => node.props.title === t('settingsVoice.realtimeProviders.elevenLabs.openAccount')
        && typeof node.props.onPress === 'function')[0];
      expect(resource).toBeDefined();
      await act(async () => { resource!.props.onPress(); await flushHookEffects(); });
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); canOpen.mockRestore(); }
  });
  function configField(provider: unknown, key: string): unknown {
    if (!provider || typeof provider !== 'object' || !('config' in provider)) return undefined;
    const value = provider.config;
    return value && typeof value === 'object' && !Array.isArray(value) && key in value
      ? Reflect.get(value, key) : undefined;
  }
  function observeAdmissionMetadata() {
    const identity = deriveVoiceCredentialBindingIdentityV1({ pluginId: provider.entry.pluginId, contribution: provider.entry.declaration });
    if (!identity) throw new Error('Expected declared ElevenLabs credential identity');
    const host = getCurrentBundledConversationRuntimeHost();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const registration = provider.registration;
    const read = () => {
      const state = storage.getState();
      const purpose = getConnectedAccountCatalogValue(account.scope, 'purposes');
      const reference = resolveAccountVoiceCredential(state.settings, contribution, identity.credentialSlotId, null);
      const saved = reference ? resolveSavedSecretReference(state.settingsScope, state.settings.secrets, reference.secretId) : null;
      let source: ReturnType<typeof resolveAccountVoiceCredentialSourceSelection> | null = null;
      try {
        source = resolveAccountVoiceCredentialSourceSelection({ settings: state.settings,
          connectedPurposes: purpose.status === 'ready' && !purpose.stale ? purpose.value : null,
          contribution, credentialSlotId: identity.credentialSlotId, purpose: identity.purpose, machineId: null });
      } catch { /* A diagnostic records indeterminate authority, never replaces its guard. */ }
      return { scope: state.settingsScope, version: state.settingsVersion,
        provider: state.settings.voiceSettingsV1.providers[providerId] ?? null,
        binding: state.settings.voiceSettingsV1.credentialBindings.find(candidate =>
          candidate.contribution.pluginId === contribution.pluginId && candidate.contribution.localId === contribution.localId
          && candidate.credentialSlotId === identity.credentialSlotId) ?? null,
        saved, secret: saved?.secret ?? null, source,
        purposeStatus: purpose.status, purposeStale: purpose.stale,
      };
    };
    let baseline: ReturnType<typeof read> | null = null;
    let signal: AbortSignal | null = null;
    const events: Array<Readonly<Record<string, string | number | boolean | null>>> = [];
    const capture = (phase: string, admittedSignal?: AbortSignal | null) => {
      const current = read();
      if (admittedSignal) {
        signal = admittedSignal;
        baseline ??= current;
      }
      const catalog = getSavedSecretCatalogSnapshot(account.scope);
      events.push({ phase, version: current.version, baselineVersion: baseline?.version ?? null,
        catalogStatus: catalog?.status ?? null, catalogStale: catalog?.stale ?? null,
        legacyImportStatus: catalog?.legacyImport?.status ?? null,
        legacyImportReason: catalog?.legacyImport?.status === 'pending' ? catalog.legacyImport.reason : null,
        savedStatus: current.saved?.status ?? null, savedRevision: current.saved?.revision ?? null,
        savedRef: current.saved?.ref ?? null, sourceKind: current.source?.selection.kind ?? null,
        purposeStatus: current.purposeStatus, purposeStale: current.purposeStale,
        hostCurrent: getCurrentBundledConversationRuntimeHost() === host,
        accountLifetimeCurrent: lifetime?.isCurrent() ?? null,
        registrationCurrent: getExternalVoiceProviderRegistration(providerId) === registration,
        vendorSignalAborted: signal?.aborted ?? null,
        scopeSame: baseline ? areAccountSettingsScopesEqual(baseline.scope, current.scope) : null,
        providerSame: baseline ? areAccountSettingsJsonValuesEqual(baseline.provider, current.provider) : null,
        providerSchemaVersionSame: baseline ? baseline.provider?.schemaVersion === current.provider?.schemaVersion : null,
        providerBillingModeSame: baseline ? areAccountSettingsJsonValuesEqual(configField(baseline.provider, 'billingMode'), configField(current.provider, 'billingMode')) : null,
        providerAgentIdSame: baseline ? areAccountSettingsJsonValuesEqual(configField(baseline.provider, 'agentId'), configField(current.provider, 'agentId')) : null,
        providerTtsSame: baseline ? areAccountSettingsJsonValuesEqual(configField(baseline.provider, 'tts'), configField(current.provider, 'tts')) : null,
        bindingSame: baseline ? areAccountSettingsJsonValuesEqual(baseline.binding, current.binding) : null,
        savedReferenceSame: baseline ? areAccountSettingsJsonValuesEqual(baseline.saved, current.saved) : null,
        secretSame: baseline ? areAccountSettingsJsonValuesEqual(baseline.secret, current.secret) : null,
        sourceSame: baseline ? areAccountSettingsJsonValuesEqual(baseline.source, current.source) : null,
        settingsWrites: account.writes.length,
      });
    };
    const stop = subscribeSavedSecretCatalogSnapshots(() => capture('catalog-publication'));
    disposals.push(stop);
    capture('before-press');
    return { capture, describe: () => { capture('assertion'); return JSON.stringify({ events,
      homeRequests: account.request.mock.calls.map(([input, init]) => ({
        method: init?.method ?? 'GET', pathname: new URL(input instanceof Request ? input.url : String(input)).pathname,
      })),
    }); } };
  }
  async function requestAgentCreation(screen: Awaited<ReturnType<typeof render>>) {
    await screen.pressByTestIdAsync('voice-settings-action-create-agent');
    await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('app-shell-confirmation-confirm')).not.toBeNull());
    await screen.pressByTestIdAsync('app-shell-confirmation-confirm');
  }

  it('finishes empty-agent setup through one confirmed creation and saves a ready provider', async () => {
    const { resolveVoiceSettingsRecoveryTarget } = await import('@/voice/settings/voiceSettingsRouteFocus');
    expect(resolveVoiceSettingsRecoveryTarget('open_provider_settings', providerId)).toEqual({
      pathname: '/settings/voice/conversations',
      params: { setting: 'voiceConversations.provider.happier.voice.elevenlabs/realtime-elevenlabs.action.create-agent' },
    });
    await saveCredential();
    const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const screen = await render(account.settings.voice,
      <InjectedAuthProvider credentials={account.credentials}><VoiceConversationsSettingsScreen /></InjectedAuthProvider>);
    expect(config()).toMatchObject({ agentId: '' });
    await waitForTestEvent(screen.subscribe, () => screen.tree.findAll(node => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('settings.voice.conversations.pipeline') && node.props.testID.endsWith('.recover')
      && typeof node.props.onPress === 'function')[0], control => Boolean(control));
    const recovery = screen.tree.findAll(node => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('settings.voice.conversations.pipeline') && node.props.testID.endsWith('.recover')
      && typeof node.props.onPress === 'function')[0];
    await act(async () => { recovery!.props.onPress(); });
    await flushHookEffects();
    expect(screen.findHostByTestId('actions.confirmation-review.decision-approve')).not.toBeNull();
    expect(provider.fetch.mock.calls.filter(([input, init]) => matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create'))).toHaveLength(0);
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('app-shell-confirmation-confirm')).not.toBeNull());
    expect(provider.fetch.mock.calls.filter(([input, init]) => matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create'))).toHaveLength(0);
    await screen.pressByTestIdAsync('app-shell-confirmation-confirm');
    await waitForTestEvent(account.subscribe, () => config()?.agentId, value => value === 'agent_created');
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: 'agent_created' });
    expect(provider.fetch.mock.calls.filter(([input, init]) => matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create'))).toHaveLength(1);
    expect(createDefaultVoiceProviderRegistry().get(providerId)?.projectSettings?.(account.settings.voice.providers[providerId] ?? null)).toMatchObject({ status: 'ready' });
  });

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

  it('titles a first-party service section in words, the same way its fields are resolved', async () => {
    const base = createDefaultVoiceProviderRegistry().get(openAiProviderId);
    if (base?.kind !== 'voice.conversation-provider.v1') throw new Error('OpenAI conversation entry missing');
    const screen = await render(voiceSettingsParse({ providerId: openAiProviderId }));
    const titles = screen.tree.findAllByType(GroupComponent).map((group) => group.props.title);
    expect(titles).toContain(tLoose('settingsVoice.realtimeProviders.setup.title'));
    expect(titles).not.toContain('settingsVoice.realtimeProviders.setup.title');
  });
  it('routes an unresolved multi-source conversation SavedSecret edit through the atomic source owner', async () => {
    const screen = await render(voiceSettingsParse({ providerId: openAiProviderId }));
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
    expect(dropdown?.props.itemTrigger.detailFormatter?.(null)).toBe(tLoose('settingsVoice.realtimeProviders.catalog.credentialRequired'));
    const triggers = dropdown?.findAll(node => typeof node.type === 'string'
      && node.props.accessibilityState?.expanded === false && typeof node.props.onPress === 'function');
    expect(triggers).toHaveLength(1);
    await act(async () => triggers![0].props.onPress());
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findAllByType(DropdownMenu).find((node) => node.props.testID === 'voice-realtime-field-tts-voiceId')?.props.open).toBe(true));
    await waitForTestEvent(screen.subscribe, () => expect(screen.tree.findAllByType(OverlayPortalHost).some(host =>
      host.findAll(node => typeof node.type === 'string' && node.props.testID === 'dropdown-option-__status__').length > 0,
    )).toBe(true));
    expect(provider.fetch.mock.calls.some(([input, init]) => matchesVendorRequest(input, init, 'GET', '/v1/voices'))).toBe(false);
  });
  it('keeps credential deletion in the canonical credential item instead of rendering a competing disconnect action', async () => {
    await saveCredential();
    const screen = await render();
    expect(screen.tree.findAllByProps({ title: tLoose('settingsVoice.realtimeProviders.disconnect.title') })).toHaveLength(0);
    expect(screen.tree.findAllByType(CredentialComponent)).toHaveLength(1);
  });
  it('binds client BYOK to account SavedSecrets and requires plaintext-mode disclosure', async () => {
    const screen = await render();
    const credential = screen.tree.findByType(CredentialComponent);
    expect(credential.props).toMatchObject({ credentialSlotId: 'api_key', credentialSourcePurpose: 'voice.client-auth.elevenlabs', disclosePlainStorage: true });
    expect(credential.props).not.toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
    const enterNew = () => credential.findAll((node) => node.props.title === tLoose('settingsVoice.byo.apiKeyTitle')
      && typeof node.props.onPress === 'function')[0]!.props.onPress();
    await act(async () => enterNew());
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('web-prompt-input')).not.toBeNull());
    act(() => screen.changeTextByTestId('web-prompt-input', 'test-only-entered-key'));
    await screen.pressByTestIdAsync('web-prompt-confirm');
    await waitForAlert(t('settingsVoice.local.voiceCredential.plainStorageTitle'));
    expect(nativeAlert.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      t('settingsVoice.local.voiceCredential.plainStorageTitle'), t('settingsVoice.local.voiceCredential.plainStorageBody'),
    ]);
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.find(button => button.style === 'cancel')?.onPress?.());
    await flushHookEffects();
    expect(screen.tree.findAllByType(WebPromptModal).filter(node => node.props.visible !== false)).toHaveLength(0);
    expect(account.settings.secrets).toHaveLength(0);
    expect(account.writes).toHaveLength(0);
    await act(async () => enterNew());
    await waitForTestEvent(screen.subscribe, () => expect(screen.findByTestId('web-prompt-input')).not.toBeNull());
    act(() => screen.changeTextByTestId('web-prompt-input', 'test-only-entered-key'));
    nativeAlert.mockClear();
    await screen.pressByTestIdAsync('web-prompt-confirm');
    await waitForAlert(t('settingsVoice.local.voiceCredential.plainStorageTitle'));
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.find(button => button.style !== 'cancel')?.onPress?.());
    await waitForAlert(t('settingsVoice.externalCredentials.recipientApprovalTitle'));
    // The present user's reversible Action is direct by default. The real
    // recipient-consent tap is the final prerequisite for this credential.
    expect(account.resources).toHaveLength(0);
    expect(account.promotions).toHaveLength(0);
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.find(button => button.style !== 'cancel')?.onPress?.());
    await waitForTestEvent(account.subscribe, () => account.resources.length, count => count === 1);
    expect(account.resources).toHaveLength(1);
    expect(account.promotions).toHaveLength(1);
    expect(account.persistedSettings.secrets).toHaveLength(0);
    const resource = account.resources[0]!;
    expect('resourceId' in resource && openSavedSecretResourceStoredContentV1({ mode: 'plain',
      resourceId: resource.resourceId, storedContent: resource.storedContent })?.value).toBe('test-only-entered-key');
    expect(account.settings.voice.providers[providerId]?.config).not.toHaveProperty('apiKey');
    expect(account.persistedSettings.voice.providers[providerId]?.config).not.toHaveProperty('apiKey');
  });
  it.each([false, true])('keeps the rendered Greeting under declared Action admission (disabled=%s)', async (disabled) => {
    if (disabled) account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: {
      v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
    } }));
    const screen = await render();
    const greeting = screen.tree.findAll((node) => node.props.testIDPrefix === 'settings.voice.greeting' && Array.isArray(node.props.options))[0];
    expect(greeting).toBeTruthy();
    act(() => account.replaceVoice({ ...account.settings.voice, assistantLanguage: 'fr' }));
    await act(async () => greeting?.props.onChange('on_first_turn'));
    if (disabled) {
      expect(resolveVoiceWelcomeSelection(account.settings.voice.welcome)).toBe('off');
      expect(account.writes).toEqual([]);
    } else {
      await waitForTestEvent(account.subscribe, () => resolveVoiceWelcomeSelection(account.persistedSettings.voice.welcome), value => value === 'on_first_turn');
      expect(resolveVoiceWelcomeSelection(account.persistedSettings.voice.welcome)).toBe('on_first_turn');
      expect(account.persistedSettings.voice.assistantLanguage).toBe('fr');
    }
  });
  it('reports a bounded provisioning failure stage without persisting an unverified agent id', async () => {
    await saveCredential();
    const originalFetch = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => matchesVendorRequest(input, init, 'POST', '/v1/convai/tools')
      ? provider.response({ providerPrivateValue: 'must-not-reach-alert' }, 400) : originalFetch(input, init));
    const screen = await render();
    await requestAgentCreation(screen);
    await waitForAlert(t('common.error'));
    expect(nativeAlert.mock.calls.at(-1)?.slice(0, 2)).toEqual([t('common.error'),
      `${tLoose('settingsVoice.realtimeProviders.operationFailedUnsaved')}\n\n${t('settingsVoice.realtimeProviders.operationFailedStage', { stage: 'create_tool' })}\n${t('settingsVoice.realtimeProviders.operationFailedStatus', { status: 400 })}`]);
    expect(config()).toMatchObject({ agentId: '' });
    expect(account.writes).toHaveLength(0);
    expect(JSON.stringify(nativeAlert.mock.calls)).not.toContain('must-not-reach-alert');
    expect(screen.findHostByTestId('voice-settings-action-create-agent')?.props.disabled).toBe(true);
    await act(async () => nativeAlert.mock.calls.at(-1)?.[2]?.[0]?.onPress?.());
    await waitForTestEvent(screen.subscribe, () => screen.findHostByTestId('voice-settings-action-create-agent')?.props.disabled,
      disabled => disabled === false);
    expect(screen.findHostByTestId('voice-settings-action-create-agent')?.props.disabled).toBe(false);
  });
  it('keeps client-executed autoprovision independent of daemon selection changes', async () => {
    await saveCredential();
    const metadata = observeAdmissionMetadata();
    const existing = createDeferred<Response>();
    const requested = createDeferred<void>();
    const originalFetch = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => {
      metadata.capture('vendor:' + (init?.method ?? 'GET') + ':' + new URL(input instanceof Request ? input.url : String(input)).pathname, init?.signal);
      if (matchesVendorRequest(input, init, 'GET', '/v1/convai/agents')) {
        requested.resolve();
        return existing.promise;
      }
      return originalFetch(input, init);
    });
    const screen = await render();
    await requestAgentCreation(screen);
    await requested.promise;
    expect(provider.fetch.mock.calls.some(([input, init]) => matchesVendorRequest(input, init, 'GET', '/v1/convai/agents'))).toBe(true);
    const next = voiceSettingsParse({ ...account.settings.voice, executionMachine: { kind: 'machine', machineId: 'machine-b' } });
    const version = storage.getState().settingsVersion;
    if (version === null) throw new Error('Expected hydrated Account Settings revision');
    account.replaceSettings(settingsParse({ ...account.settings,
      ...normalizeVoiceSettingsLocalDelta({ voice: next }, account.settings) }), { version: version + 1 });
    metadata.capture('daemon-selection-published');
    await screen.update(<BundledConversationSettingsSection voice={next} />);
    await act(async () => { metadata.capture('agents-response-resolved'); existing.resolve(provider.response({ agents: [], has_more: false, next_cursor: null })); });
    await waitForTestEvent(account.subscribe, () => account.persistedSettings.voice.providers[providerId]?.config,
      value => configField({ config: value }, 'agentId') === 'agent_created');
    await waitForTestEvent(storage.subscribe, config, value => configField({ config: value }, 'agentId') === 'agent_created');
    expect(config(), metadata.describe()).toMatchObject({ agentId: 'agent_created' });
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: 'agent_created' });
  });
  it('aborts a deferred autoprovision when its provider target retires without publishing stale work', async () => {
    await saveCredential();
    const existing = createDeferred<Response>();
    const requested = createDeferred<void>();
    let signal: AbortSignal | undefined;
    const originalFetch = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => {
      if (!matchesVendorRequest(input, init, 'GET', '/v1/convai/agents')) return originalFetch(input, init);
      signal = init?.signal ?? undefined;
      requested.resolve();
      return existing.promise;
    });
    const screen = await render();
    await requestAgentCreation(screen);
    await requested.promise;
    expect(signal).toBeDefined();
    const next = voiceSettingsParse({ ...account.settings.voice, providerId: null });
    account.replaceVoice(next);
    await screen.update(<BundledConversationSettingsSection voice={next} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => existing.resolve(provider.response({ agents: [], has_more: false, next_cursor: null })));
    expect(provider.fetch.mock.calls.some(([input, init]) => matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create'))).toBe(false);
    expect(account.writes).toHaveLength(0);
  });
  it('does not let a stale legacy-secret scrub overwrite newer canonical provider settings', async () => {
    const legacy = voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: 1, config: {
      billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: { _isSecretValue: true, value: 'legacy-key' } },
      tts: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
    } } } });
    const screen = await render(legacy);
    const latest = voiceWith({ agentId: 'agent-new' });
    account.replaceVoice(latest);
    await screen.update(<BundledConversationSettingsSection voice={latest} />);
    expect(account.writes).toHaveLength(0);
    expect(config()).toMatchObject({ agentId: 'agent-new' });
  });
  it('preserves a changed provider config and reports an unconfirmed result instead of applying a stale action patch', async () => {
    await saveCredential();
    const metadata = observeAdmissionMetadata();
    const created = createDeferred<Response>();
    const requested = createDeferred<void>();
    const originalFetch = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => {
      metadata.capture('vendor:' + (init?.method ?? 'GET') + ':' + new URL(input instanceof Request ? input.url : String(input)).pathname, init?.signal);
      if (!matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create')) return originalFetch(input, init);
      await originalFetch(input, init);
      requested.resolve();
      return created.promise;
    });
    const screen = await render();
    await requestAgentCreation(screen);
    await requested.promise;
    expect(provider.fetch.mock.calls.some(([input, init]) => matchesVendorRequest(input, init, 'POST', '/v1/convai/agents/create')), metadata.describe()).toBe(true);
    const next = voiceSettingsParse({ ...account.settings.voice,
      providers: voiceWith({ tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, voiceId: 'voice-new' } }).providers });
    const version = storage.getState().settingsVersion;
    if (version === null) throw new Error('Expected hydrated Account Settings revision');
    account.replaceSettings(settingsParse({ ...account.settings,
      ...normalizeVoiceSettingsLocalDelta({ voice: next }, account.settings) }), { version: version + 1 });
    metadata.capture('same-provider-config-published');
    await act(async () => { metadata.capture('agent-response-resolved'); created.resolve(provider.response({ agent_id: 'agent-new' })); });
    await waitForAlert(t('common.error'));
    expect(nativeAlert.mock.calls.at(-1)?.slice(0, 2), metadata.describe()).toEqual([
      t('common.error'), t('settingsProviders.errors.mutationOutcomeUnknownDescription'),
    ]);
    expect(config()).toMatchObject({ agentId: '', tts: { voiceId: 'voice-new' } });
    expect(account.writes).toHaveLength(0);
    expect(account.persistedSettings.voice.providers[providerId]?.config).toMatchObject({ agentId: '', tts: { voiceId: 'voice-new' } });
  });
  it('fails closed instead of treating secret-shaped canonical data as a legacy import source', async () => {
    const voice = voiceSettingsParse({ providerId, providers: { [providerId]: { schemaVersion: 2, config: {
      billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: { _isSecretValue: true, value: 'must-not-import' } },
    } } } });
    const screen = await render(voice);
    expect(screen.tree.findAllByType(CredentialComponent)).toHaveLength(0);
    expect(screen.tree.findAllByProps({ title: tLoose('settingsVoice.realtimeProviders.unavailable.rowTitle') }).length).toBeGreaterThan(0);
    expect(account.settings.secrets).toHaveLength(0);
    expect(account.writes).toHaveLength(0);
  });
});
