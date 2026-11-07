import * as React from 'react';
import { Alert } from 'react-native';
import 'fake-indexeddb/auto';
import { createDeferred, flushHookEffects, renderScreen, waitForTestEvent } from '@/dev/testkit';
import * as gestureDispatch from '@/utils/system/fireAndForget';
import { ModalProvider } from '@/modal';
import { log } from '@/log';
import { CustomModal } from '@/modal/components/CustomModal';
import { t, setPreferredLanguageFromSettings } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot, resolveSavedSecretReference, subscribeSavedSecretCatalogSnapshots } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createRecipientContractDigestV1,
  VoiceProviderContributionSchema,
} from '@happier-dev/protocol';
import type {
  PluginSettingsActionDeclarationV2,
  VoiceProviderSettingsActionDeclaration,
} from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-elevenlabs/manifest';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '@happier-dev/plugins-elevenlabs/protocol/voice';

import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration, type ExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createElevenLabsSettingsRuntimeTestHarness, createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from '../voiceSettingsAccountTestHarness';
import { VoiceProviderSettingsJsonValueV1Schema } from '@happier-dev/protocol/voice/realtime/providerSettings';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

let accountFixture: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
let registration: ExternalVoiceProviderRegistration | null = null;
let provider: ReturnType<typeof createElevenLabsSettingsRuntimeTestHarness>;
let modalTree: renderer.ReactTestRenderer;
function providerUrl(input: Parameters<RuntimeFetch>[0]) {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}
async function providerBody(init: RequestInit | undefined): Promise<unknown> {
  if (!init?.body) throw new Error('Expected provider-authored HTTP body');
  return await new Response(init.body).json();
}
async function replaceProviderRegistration() {
  await provider.register();
  registration = provider.registration;
}
const humanConfirmations: Array<() => void> = [];
const gestureObservation = vi.spyOn(gestureDispatch, 'fireAndForget');
function mountedOperation() {
  const call = gestureObservation.mock.calls.filter(([, options]) => options?.tag?.startsWith('VoiceProviderSettingsActions.')).at(-1);
  if (!call) throw new Error('Expected the real mounted provider operation promise');
  return call[0];
}
async function settleMountedOperation() {
  await mountedOperation();
}
async function waitForConfirmation(count: number) {
  await waitForTestEvent(modalTree.subscribe, () => modalTree.root.findAll(node => typeof node.type === 'string'
    && node.props.testID === 'app-shell-confirmation-confirm').at(-1), control => Boolean(control));
  const control = modalTree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'app-shell-confirmation-confirm').at(-1);
  expect(control).toBeTruthy();
  if (humanConfirmations.length < count) humanConfirmations.push(control!.props.onPress);
  expect(humanConfirmations).toHaveLength(count);
}
function hasConfirmation() {
  return modalTree.root.findAllByType(CustomModal).some(node => node.props.visible === true
    && node.findAll(child => typeof child.type === 'string' && child.props.testID === 'app-shell-confirmation-confirm').length > 0);
}
async function saveCredential() {
  const declaration = VoiceProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.voiceProviders?.[0]);
  const recipient = createBundledVoiceRecipientContract({ pluginId: PLUGIN_MANIFEST.id, declaration });
  if (!recipient) throw new Error('Expected ElevenLabs recipient contract');
  accountFixture.replaceSettings(await withVoiceSettingsCredentialResource(accountFixture, {
    settings: accountFixture.settings, declaration, pluginId: PLUGIN_MANIFEST.id,
    resourceId: 'elevenlabs-secret', recipientContractDigest: createRecipientContractDigestV1(recipient),
  }));
  await refreshSavedSecretCatalog(accountFixture.scope);
  // Admit the operation only after the real material catalog is current.
  await waitForTestEvent(subscribeSavedSecretCatalogSnapshots, () => {
    expect(getSavedSecretCatalogSnapshot(accountFixture.scope)).toMatchObject({
      status: 'ready', stale: false, legacyImport: { status: 'complete' },
    });
    const binding = accountFixture.settings.voiceSettingsV1.credentialBindings.find(candidate =>
      candidate.contribution.pluginId === PLUGIN_MANIFEST.id && candidate.contribution.localId === 'realtime-elevenlabs');
    expect(resolveSavedSecretReference(accountFixture.scope, accountFixture.settings.secrets,
      binding?.credentialBindings.account?.api_key ?? '')).toMatchObject({ status: 'ready', kind: 'shared_resource' });
  });
}
function replaceVoiceFixture(change: Partial<Settings['voice']>) {
  accountFixture.replaceVoice({ ...storage.getState().settings.voice, ...change });
}
function withProviderConfig(settings: Settings, config: Record<string, unknown>) {
  const voice = { ...settings.voice, providers: { ...settings.voice.providers,
    [PROVIDER_ID]: { schemaVersion: 2, config: VoiceProviderSettingsJsonValueV1Schema.parse(config) } } };
  return settingsParse({ ...settings, ...normalizeVoiceSettingsLocalDelta({ voice }, settings) });
}
const state = {
  get config() { return storage.getState().settings.voice.providers[PROVIDER_ID]?.config as Record<string, unknown>; },
  set config(config: Record<string, unknown>) {
    replaceVoiceFixture({ providers: { ...storage.getState().settings.voice.providers,
      [PROVIDER_ID]: { schemaVersion: state.schemaVersion, config: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, ...config,
        tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, ...(config.tts as object) },
      } } } });
  },
  get schemaVersion() { return storage.getState().settings.voice.providers[PROVIDER_ID]?.schemaVersion ?? 2; },
  set schemaVersion(schemaVersion: number) {
    replaceVoiceFixture({ providers: { ...storage.getState().settings.voice.providers,
      [PROVIDER_ID]: { schemaVersion, config: VoiceProviderSettingsJsonValueV1Schema.parse(state.config) } } });
  },
  get settingsVersion() { return storage.getState().settingsVersion ?? 1; },
  conflict: null as null | 'unrelated' | 'provider',
  mutationAttempts: 0,
  outcomeUnknown: false,
  mutationApplied: false,
  advanceDuringPreparation: false,
  get registration() { return registration; },
  set registration(next: ExternalVoiceProviderRegistration | null) {
    if (registration) removeExternalVoiceProviderRegistration(registration.token);
    registration = next;
    if (next) commitExternalVoiceProviderRegistration(next);
  },
  get selectedProviderId() { return storage.getState().settings.voice.providerId; },
  set selectedProviderId(providerId: string | null) { replaceVoiceFixture({ providerId }); },
};
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const actionScreens = new WeakMap<renderer.ReactTestRenderer, Awaited<ReturnType<typeof renderScreen>>>();
async function mountActionView(element: React.ReactElement) {
  const screen = await renderScreen(element);
  onTestFinished(screen.unmount);
  actionScreens.set(screen.tree, screen);
  return screen.tree;
}
async function updateActionView(tree: renderer.ReactTestRenderer, element: React.ReactElement) {
  const screen = actionScreens.get(tree);
  if (!screen) throw new Error('Expected mounted Action screen');
  await screen.update(element);
}

const PROVIDER_ID = vi.hoisted(() => 'happier.voice.elevenlabs/realtime-elevenlabs');

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const nativeAlert = vi.spyOn(Alert, 'alert');

const action: PluginSettingsActionDeclarationV2 = {
  id: 'create-agent',
  title: 'Create agent',
  placement: { kind: 'afterField', fieldId: 'agentId' },
  confirmation: {
    kind: 'required',
    title: 'Create?',
    description: 'Creates the agent.',
    confirmLabel: 'Create',
  },
  patchFieldIds: ['agentId'],
};

const conditionalUpdateAction: VoiceProviderSettingsActionDeclaration = {
  ...action,
  id: 'update-agent',
  title: 'Update agent',
  enabledWhen: { kind: 'setting_nonempty', settingId: 'agentId' },
};

const settingsOwner = createDefaultVoiceProviderRegistry().get(PROVIDER_ID)?.providerSettings;
if (!settingsOwner || !settingsOwner.defaultConfig || typeof settingsOwner.defaultConfig !== 'object' || Array.isArray(settingsOwner.defaultConfig)) throw new Error('Expected ElevenLabs catalog settings owner');
const owner = {
  schemaVersion: settingsOwner.schemaVersion,
  defaultConfig: settingsOwner.defaultConfig,
  parseConfig: (value: unknown) => {
    const parsed = settingsOwner.parseConfig(value);
    return isConfigRecord(parsed) ? parsed : null;
  },
};

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('VoiceProviderSettingsActions', () => {
  it('offers one inline operation chosen from the contributed agent state', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const contribution = VoiceProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.voiceProviders?.[0]);
    const actions = contribution.settings?.actions ?? [];
    const agentAction = { settingId: 'agentId', createActionId: 'create-agent', updateActionId: 'update-agent',
      titleKey: 'agent', missingStateKey: 'missing', configuredStateKey: 'configured' };
    let tree!: renderer.ReactTestRenderer;
    const render = (agentId: string) => <VoiceProviderSettingsActions providerId={PROVIDER_ID} owner={owner}
      actions={actions} config={{ ...state.config, agentId }} agentAction={agentAction}
      placement={{ kind: 'afterField', fieldId: 'agentId' }} />;
    await act(async () => { tree = await mountActionView(render('')); });
    const buttons = () => [...new Set(tree.root.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('voice-settings-action-')).map((node) => node.props.testID))];
    expect(buttons()).toEqual(['voice-settings-action-create-agent']);
    await act(async () => { await updateActionView(tree, render('existing-agent')); });
    expect(buttons()).toEqual(['voice-settings-action-update-agent']);
    await act(async () => { tree.unmount(); });
  });
  beforeEach(async () => {
    accountFixture = await createVoiceSettingsAccountTestHarness(settingsParse({
      voice: { providerId: PROVIDER_ID, providers: { [PROVIDER_ID]: {
        schemaVersion: 2, config: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS, billingMode: 'byo', agentId: '' },
      } } },
    }));
    onTestFinished(async () => { state.registration = null; await accountFixture.dispose(); });
    accountFixture.replaceSettings(storage.getState().settings, { version: 4 });
    const request = accountFixture.request.getMockImplementation()!;
    accountFixture.request.mockImplementation(async (url, init) => {
      if (providerUrl(url).pathname === '/v2/account/settings') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const isActionPatch = body.content?.t === 'plain'
            && body.content.v?.voiceSettingsV1?.providers?.[PROVIDER_ID]?.config?.agentId === 'agent_created';
          if (isActionPatch) {
            state.mutationAttempts += 1;
          }
          if (state.conflict) {
            const providerChanged = state.conflict === 'provider';
            state.conflict = null;
            const current = storage.getState().settings;
            accountFixture.replaceSettings(providerChanged
              ? withProviderConfig(current, { ...state.config, billingMode: 'happier' })
              : settingsParse({ ...current, analyticsOptOut: !current.analyticsOptOut }),
              { version: state.settingsVersion + 1, publish: false });
          }
          if (state.outcomeUnknown && isActionPatch) throw new Error('transport_response_lost');
          const result = await request(url, init);
          if (isActionPatch) state.mutationApplied = result.ok && (await result.clone().json()).success === true;
          return result;
        }
        if (state.outcomeUnknown && state.mutationAttempts > 0) throw new Error('transport_read_unavailable');
      }
      return request(url, init);
    });
    state.config = { billingMode: 'byo', agentId: '', tts: {} };
    state.schemaVersion = 2;
    state.conflict = null;
    state.mutationAttempts = 0;
    state.outcomeUnknown = false;
    state.mutationApplied = false;
    state.advanceDuringPreparation = false;
    state.selectedProviderId = PROVIDER_ID;
    humanConfirmations.length = 0;
    gestureObservation.mockClear();
    nativeAlert.mockReset();
    nativeAlert.mockImplementation((_title, _body, buttons) => { buttons?.find(button => button.style !== 'cancel')?.onPress?.(); });
    log.clear();
    provider = createElevenLabsSettingsRuntimeTestHarness();
    await saveCredential();
    await provider.register();
    registration = provider.registration;
    setPreferredLanguageFromSettings('en');
    modalTree = (await renderScreen(<ModalProvider><></></ModalProvider>)).tree;
    onTestFinished(async () => { await act(async () => modalTree.unmount()); await provider.dispose(); });
  });

  it('admits an agent-requested operation only after real confirmation and reports the applied patch', async () => {
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    let pending!: ReturnType<typeof invokeVoiceProviderSettingsAction>;
    await act(async () => { pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action }); });
    await waitForConfirmation(1);
    expect(state.mutationApplied).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
    await act(async () => humanConfirmations[0]!());
    expect(await pending).toEqual({ status: 'completed' });
    expect(accountFixture.persistedSettings.voice.providers[PROVIDER_ID]?.config).toMatchObject({ agentId: 'agent_created' });
    expect(state.config.agentId, JSON.stringify({
      persistedConfig: accountFixture.persistedSettings.voice.providers[PROVIDER_ID]?.config,
      canonicalConfig: accountFixture.settings.voiceSettingsV1.providers[PROVIDER_ID]?.config,
      runtimeConfig: state.config,
      mutationAttempts: state.mutationAttempts,
    })).toBe('agent_created');
  });

  it('refuses a mounted contributed operation before provider confirmation or effects while adjacent settings writes remain allowed', async () => {
    accountFixture.replaceSettings(settingsParse({ ...accountFixture.settings, actionsSettingsV1: {
      v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
    } }));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = await mountActionView(<VoiceProviderSettingsActions providerId={PROVIDER_ID}
      owner={owner} actions={[action]} placement={{ kind: 'afterField', fieldId: 'agentId' }} />); });
    const before = accountFixture.writes.length;
    await act(async () => { tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress(); });
    expect(hasConfirmation()).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(accountFixture.writes).toHaveLength(before);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    expect(await createDefaultActionExecutor().execute('settings.set', { anchor: 'voicePrivacy.recentMessagesCount', value: 9 }, {
      surface: 'ui', authority: 'present_user', serverId: accountFixture.scope.serverId, expectedAccountId: accountFixture.scope.accountId,
    })).toMatchObject({ ok: true });
    expect(accountFixture.persistedSettings.voice.privacy.recentMessagesCount).toBe(9);
    accountFixture.replaceSettings(settingsParse({ ...accountFixture.settings, actionsSettingsV1: { v: 1, actions: {} } }));
    await flushHookEffects();
    await act(async () => { tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress(); });
    await waitForConfirmation(1);
    await act(async () => { humanConfirmations[0]!(); await settleMountedOperation(); });
    expect(state.mutationApplied).toBe(true);
  });

  it('leaves the provider and settings untouched when the human declines an agent operation', async () => {
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    let pending!: ReturnType<typeof invokeVoiceProviderSettingsAction>;
    await act(async () => { pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action }); });
    await waitForConfirmation(1);
    await act(async () => modalTree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'app-shell-confirmation-decline').at(-1)!.props.onPress());
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(state.mutationApplied).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it('does not expose plugin-supplied failure text through an operation result', async () => {
    provider.fetch.mockRejectedValueOnce({ code: 'private_provider_payload', message: 'private_provider_payload' });
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    let pending!: ReturnType<typeof invokeVoiceProviderSettingsAction>;
    await act(async () => { pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action }); });
    await waitForConfirmation(1);
    await act(async () => humanConfirmations[0]!());
    const result = await pending;
    expect(result).toMatchObject({ status: 'unavailable', reason: 'internal_error' });
    expect(JSON.stringify(result)).not.toContain('private_provider_payload');
    expect(state.mutationApplied).toBe(false);
  });

  it('retains a future provider envelope instead of invoking against defaults', async () => {
    state.schemaVersion = 99;
    const original = state.config;
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    let pending!: ReturnType<typeof invokeVoiceProviderSettingsAction>;
    await act(async () => { pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action }); });
    await waitForConfirmation(1);
    await act(async () => humanConfirmations[0]!());
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'voice_provider_settings_invalid' });
    expect(state.config).toBe(original);
    expect(state.mutationApplied).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it('retires the captured Action Account before confirmation can invoke a new current Account', async () => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const capturedAccount = await captureLazyActionAccountContext(accountFixture.scope.serverId);
    onTestFinished(() => capturedAccount.dispose());
    const { invokeVoiceProviderSettingsAction } = await import('@/voice/settings/voiceProviderSettingsActionInvoker');
    let pending!: ReturnType<typeof invokeVoiceProviderSettingsAction>;
    await act(async () => { pending = invokeVoiceProviderSettingsAction({ providerId: PROVIDER_ID, owner, declaration: action,
      isCurrent: capturedAccount.accountLifetime.isCurrent }); });
    await waitForConfirmation(1);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    await TokenStorage.removeCredentialsForServerUrl(capturedAccount.endpointUrl);
    const replacementAccount = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    onTestFinished(() => replacementAccount.dispose());
    expect(capturedAccount.accountLifetime.isCurrent()).toBe(false);
    await act(async () => humanConfirmations[0]!());
    expect(await pending).toMatchObject({ status: 'unavailable' });
    expect(state.mutationApplied).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it('retires the old producer confirmation and admits a fresh confirmation after occurrence replacement', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);

    await act(async () => replaceProviderRegistration());
    await act(async () => {
      await updateActionView(tree, <VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      await settleMountedOperation();
      expect(tree.root.findByProps({
        testID: 'voice-settings-action-create-agent',
      }).props.loading).toBe(false);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(2);
    await act(async () => {
      humanConfirmations[0]!();
    });
    expect(provider.fetch).not.toHaveBeenCalled();
    await act(async () => {
      humanConfirmations[1]!();
      await settleMountedOperation();
      expect(state.config.agentId).toBe('agent_created');
    });
    await act(async () => {
      tree.unmount();
    });
  });

  it('fails closed when a settings-action registration has no producer occurrence', async () => {
    // Malformed external plugin registration exercises the host's runtime admission guard.
    state.registration = Object.freeze({
      ...state.registration,
      occurrenceId: undefined,
    }) as ExternalVoiceProviderRegistration;
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('enables a declared nonempty action only after its setting has a value', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={state.config}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    const disabledRow = tree.root.findByProps({ testID: 'voice-settings-action-update-agent' });
    expect(disabledRow.props.disabled).toBe(true);
    disabledRow.props.onPress();
    expect(hasConfirmation()).toBe(false);

    const configured = { ...state.config, agentId: 'agent-existing' };
    await act(async () => {
      await updateActionView(tree, <VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={configured}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-update-agent',
    }).props.disabled).toBe(false);
  });

  it('renders from the declaration and applies the bounded patch through one-shot Account Settings CAS', async () => {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { SettingsDeclarationActionOutputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
    const listed = await createDefaultActionExecutor().execute('settings.list', { pageId: 'voiceConversations' }, {
      surface: 'ui', authority: 'present_user', serverId: accountFixture.scope.serverId, expectedAccountId: accountFixture.scope.accountId,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.errorCode);
    const declared = SettingsDeclarationActionOutputSchemasV1['settings.list'].parse(listed.result).items
      .find(item => item.anchor === `voiceConversations.provider.${PROVIDER_ID}.action.create-agent`);
    expect(declared).toMatchObject({ operation: { actionId: 'settings.invoke' } });
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await flushHookEffects();
    const row = tree.root.findByProps({ testID: 'voice-settings-action-create-agent' });
    expect(row.props.title).toBe('Create agent');
    await act(async () => {
      row.props.onPress();
    });
    await waitForConfirmation(1);
    // The admitted Action confirms the producer's declaration, not caller-supplied row props.
    const confirmation = provider.entry.declaration.settings?.actions?.find(candidate => candidate.id === action.id)?.confirmation;
    if (!confirmation || confirmation.kind !== 'required') throw new Error('Expected producer confirmation');
    const text = (value: string | Readonly<{ key: string; fallback: string }>) => typeof value === 'string' ? value : value.fallback;
    expect(modalTree.root.findAllByType(CustomModal).find(node => node.props.visible)?.props.config).toMatchObject({
      props: { description: text(confirmation.description), confirmLabel: text(confirmation.confirmLabel) },
      chrome: { title: text(confirmation.title), testID: 'app-shell-transient-interaction-dialog' },
    });
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(state.mutationApplied).toBe(true);
    });
    const created = provider.fetch.mock.calls.find(([input, init]) => providerUrl(input).pathname === '/v1/convai/agents/create' && init?.method === 'POST');
    expect(await providerBody(created?.[1])).toMatchObject({ conversation_config: expect.any(Object) });
    expect(state.config.agentId).toBe('agent_created');
  });

  it('pairs action values with the same canonical revision when settings advance during preparation', async () => {
    state.advanceDuringPreparation = true;
    const beforePreparationVersion = state.settingsVersion;
    // Deliver the competing Home update as the pending Settings flush publishes,
    // before preparation resumes. A later credential-catalog GET is execution,
    // not preparation, and must not change the action's admitted authority.
    const unsubscribe = storage.subscribe(snapshot => {
      if (!state.advanceDuringPreparation || snapshot.settingsVersion !== beforePreparationVersion + 1) return;
      state.advanceDuringPreparation = false;
      accountFixture.replaceSettings(withProviderConfig(snapshot.settings, {
        ...state.config, billingMode: 'happier', tts: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
          voiceSettings: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceSettings, stability: 0.25 },
        },
      }), { version: beforePreparationVersion + 2 });
    });
    onTestFinished(unsubscribe);
    const http = provider.fetch.getMockImplementation()!;
    let revisionAtProvisioning: number | undefined;
    provider.fetch.mockImplementation(async (input, init) => {
      if (providerUrl(input).pathname === '/v1/convai/agents/create' && init?.method === 'POST') revisionAtProvisioning = state.settingsVersion;
      return await http(input, init);
    });
    const { sync } = await import('@/sync/sync');
    sync.applySettings({ analyticsOptOut: true }, { expectedSettingsScope: accountFixture.scope });
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(state.mutationApplied, JSON.stringify({
        settingsVersion: state.settingsVersion, mutationAttempts: state.mutationAttempts,
        requests: provider.fetch.mock.calls.map(([input]) => providerUrl(input).pathname),
        failures: log.getLogs().filter(line => line.includes('voiceRuntimeFailure')),
        alerts: nativeAlert.mock.calls.map(([title, body]) => ({ title, body })),
      })).toBe(true);
    });

    const created = provider.fetch.mock.calls.find(([input, init]) => providerUrl(input).pathname === '/v1/convai/agents/create' && init?.method === 'POST');
    expect(state.config.tts).toMatchObject({ voiceSettings: { stability: 0.25 } });
    expect(await providerBody(created?.[1])).toMatchObject({ conversation_config: { tts: { stability: 0.25 } } });
    expect(revisionAtProvisioning).toBeTypeOf('number');
    expect(accountFixture.writes.at(-1)).toMatchObject({ expectedVersion: revisionAtProvisioning });
    expect(state.config.billingMode).toBe('happier');
    expect(state.mutationAttempts).toBe(1);
  });

  it('reconciles once when a CAS conflict changed no provider config read by the action', async () => {
    state.conflict = 'unrelated';
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(state.mutationApplied).toBe(true);
    });
    expect(state.mutationAttempts).toBe(2);
    expect(state.config.agentId).toBe('agent_created');
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it('does not merge after a CAS conflict changed provider config read by the action', async () => {
    state.conflict = 'provider';
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });
    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('');
    expect(state.config.billingMode).toBe('happier');
    expect(state.mutationAttempts).toBe(1);
    expect(nativeAlert.mock.calls.map(call => call.slice(0, 2))).toContainEqual([
      t('common.error'),
      t('settingsProviders.errors.mutationOutcomeUnknownDescription'),
    ]);
  });

  it('surfaces an ambiguous Account Settings action patch without claiming it applied', async () => {
    state.outcomeUnknown = true;
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
    });
    await act(async () => { await settleMountedOperation(); });
    expect(nativeAlert.mock.calls.map(call => call.slice(0, 2)), JSON.stringify({
      mutationAttempts: state.mutationAttempts,
      providerRequests: provider.fetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${providerUrl(input).pathname}`),
      settingsRequests: accountFixture.request.mock.calls.filter(([input]) => providerUrl(input).pathname === '/v2/account/settings')
        .map(([, init]) => init?.method ?? 'GET'),
      logs: log.getLogs(),
    })).toContainEqual([
      t('common.error'),
      t('settingsProviders.errors.mutationOutcomeUnknownDescription'),
    ]);

    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('');
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed {"actionId":"create-agent","code":"voice_provider_settings_action_outcome_unknown"}',
    );
  });

  it('surfaces the failing stage and status while stripping provider prose from the log and the alert', async () => {
    const http = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => {
      if (providerUrl(input).pathname !== '/v1/convai/agents/create') return await http(input, init);
      return new Response(JSON.stringify({ detail:
        'HAPPIER_PROVIDER_PROSE_SENTINEL private-agent-id secret credential: tool ids must be owned by this workspace' }), {
        status: 422,
        headers: { 'content-type': 'application/json', authorization: 'secret credential', 'x-provider-request-id': 'private-agent-id' },
      });
    });
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });

    expect(log.getLogs().filter(message => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed {"actionId":"create-agent","code":"provider_response_invalid","stage":"create_agent","responseFailure":{"kind":"http_status","status":422,"statusClass":"4xx"}}',
    );
    // The press is still actionable: the alert names the failing step and the
    // provider status without repeating a single character of provider prose.
    expect(nativeAlert.mock.calls.map(call => call.slice(0, 2))).toContainEqual([
      t('common.error'),
      t('settingsVoice.realtimeProviders.operationFailedUnsaved')
        + '\n\n' + t('settingsVoice.realtimeProviders.operationFailedStage', { stage: 'create_agent' })
        + '\n' + t('settingsVoice.realtimeProviders.operationFailedStatus', { status: 422 }),
    ]);
    const surfaced = JSON.stringify([log.getLogs(), nativeAlert.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('secret credential');
    expect(surfaced).not.toContain('private-agent-id');
  });

  it('composes the final ElevenLabs Agent PATCH HTTP failure into a safe actionable diagnostic without applying settings', async () => {
    const providerProse = 'HAPPIER_PROVIDER_PROSE_SENTINEL agent configuration is private';
    const failureResponse = new Response(providerProse, { status: 400 });
    const responseBody = failureResponse.body;
    if (!responseBody) throw new Error('elevenlabs_failure_body_missing');
    const responseConsumers = [
      vi.spyOn(responseBody, 'getReader'),
      vi.spyOn(failureResponse, 'text'),
      vi.spyOn(failureResponse, 'json'),
      vi.spyOn(failureResponse, 'arrayBuffer'),
    ];
    const cancelBody = vi.spyOn(responseBody, 'cancel');
    provider.fetch.mockImplementation(async (input, init) => {
      const request = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (request.pathname === '/v1/voices') {
        return new Response(JSON.stringify({
          voices: [{ voice_id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Default Happier Voice' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (request.pathname === '/v1/convai/tools' && init?.method === 'GET') {
        return new Response(JSON.stringify({ tools: [], has_more: false, next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.pathname === '/v1/convai/tools' && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: `tool-${provider.fetch.mock.calls.length}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.pathname === '/v1/convai/agents/agent-existing') {
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({
            agent_id: 'agent-existing',
            conversation_config: { agent: { prompt: { tool_ids: [] } } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(init?.method).toBe('PATCH');
        return failureResponse;
      }
      throw new Error(`unexpected_elevenlabs_operation:${request.pathname}`);
    });
    state.config = {
      billingMode: 'byo',
      agentId: 'agent-existing',
      tts: {
        voiceId: 'hpp4J3VqNfWAUOO0d1Us',
        modelId: null,
        voiceSettings: { stability: null, similarityBoost: null, speed: null },
      },
    };
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[conditionalUpdateAction]}
        config={state.config}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-update-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });

    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"update-agent","code":"provider_response_invalid","stage":"update_agent"'
      + ',"responseFailure":{"kind":"http_status","status":400,"statusClass":"4xx"}}',
    );
    const providerMutations = provider.fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(providerMutations).toHaveLength(1);
    expect(state.mutationApplied).toBe(false);
    expect(state.config.agentId).toBe('agent-existing');
    for (const consume of responseConsumers) expect(consume).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(nativeAlert.mock.calls.map(call => call.slice(0, 2))).toContainEqual([
      t('common.error'),
      t('settingsVoice.realtimeProviders.operationFailedUnsaved')
        + '\n\n' + t('settingsVoice.realtimeProviders.operationFailedStage', { stage: 'update_agent' })
        + '\n' + t('settingsVoice.realtimeProviders.operationFailedStatus', { status: 400 }),
    ]);
    const surfaced = JSON.stringify([log.getLogs(), nativeAlert.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('elevenlabs-secret');
    expect(surfaced).not.toContain('agent-existing');
  });

  it('tells the user which setting to fix when the provider reports a typed unusable-voice code', async () => {
    const http = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => providerUrl(input).pathname === '/v1/voices'
      ? provider.response({ voices: [{ voice_id: 'another-voice', name: 'HAPPIER_PROVIDER_PROSE_SENTINEL private-request-id' }] })
      : await http(input, init));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });

    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });

    expect(state.mutationApplied).toBe(false);
    // The remedy replaces the generic "changes were not saved" headline: the
    // user is told the selected voice is the thing to change.
    expect(nativeAlert.mock.calls.map(call => call.slice(0, 2))).toContainEqual([
      t('common.error'),
      t('settingsVoice.realtimeProviders.operationFailedVoiceNotFound')
        + '\n\n' + t('settingsVoice.realtimeProviders.operationFailedStage', { stage: 'validate_voice' }),
    ]);
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","code":"voice_not_found","stage":"validate_voice"}',
    );
    const surfaced = JSON.stringify([log.getLogs(), nativeAlert.mock.calls]);
    expect(surfaced).not.toContain('HAPPIER_PROVIDER_PROSE_SENTINEL');
    expect(surfaced).not.toContain('private-request-id');
  });

  it('quietly clears busy state without CAS mutation when the user cancels an interaction', async () => {
    const http = provider.fetch.getMockImplementation()!;
    provider.fetch.mockImplementation(async (input, init) => providerUrl(input).pathname === '/v1/convai/agents' && init?.method === 'GET'
      ? provider.response({ agents: [{ agent_id: 'agent-existing', name: 'Happier Voice', tags: ['happier_voice_config_v1'] }], has_more: false, next_cursor: null })
      : await http(input, init));
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
    });
    await waitForTestEvent(modalTree.subscribe, () => modalTree.root.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'app-shell-question-cancel'), controls => controls.length === 1);
    expect(modalTree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'app-shell-question-cancel')).toHaveLength(1);
    await act(async () => {
      modalTree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'app-shell-question-cancel')[0]!.props.onPress();
    });
    await act(async () => { await settleMountedOperation(); });
    expect(tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.loading).toBe(false);
    expect(state.mutationApplied).toBe(false);
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it('names a confirmation that could not be presented instead of doing nothing', async () => {
    await act(async () => modalTree.unmount());
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(log.getLogs().filter(message => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","code":"voice_provider_settings_action_confirmation_unavailable"}',
    );
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-create-agent',
    }).props.loading).toBe(false);
  });

  it('names a generation retired under a still-mounted panel and frees the action again', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    // The activation scope re-commits the provider registration while the
    // panel stays mounted, retiring the old producer's invocation lifecycle.
    await act(async () => replaceProviderRegistration());
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(nativeAlert).toHaveBeenCalled();
    });
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(log.getLogs().filter(message => message.startsWith('[VoiceProviderSettingsActions]'))).toHaveLength(1);
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action failed'
      + ' {"actionId":"create-agent","aborted":true,"retired":true,"code":"plugin_settings_action_generation_retired"}',
    );
    expect(tree.root.findByProps({
      testID: 'voice-settings-action-create-agent',
    }).props.loading).toBe(false);
  });

  it('stays quiet but nameable when the user selects another provider mid-press', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => { state.selectedProviderId = 'happier.voice.openai/realtime-openai'; });
    await act(async () => {
      humanConfirmations[0]!();
      await settleMountedOperation();
      expect(log.getLogs().length).toBeGreaterThan(0);
    });
    expect(nativeAlert).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
    expect(log.getLogs()).toContain(
      '[VoiceProviderSettingsActions] settings action deselected'
      + ' {"actionId":"create-agent","retired":true,"code":"plugin_settings_action_generation_retired"}',
    );
  });

  it('retires and dismisses a pending confirmation before execute/CAS, then admits its replacement', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);

    await act(async () => replaceProviderRegistration());
    await act(async () => {
      await updateActionView(tree, <VoiceProviderSettingsActions {...props} />);
    });
    await flushHookEffects({ cycles: 1, turns: 4, frames: 1 });
    expect(hasConfirmation()).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);

    await act(async () => {
      await settleMountedOperation();
      expect(tree.root.findByProps({
        testID: 'voice-settings-action-create-agent',
      }).props.loading).toBe(false);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(2);
    await act(async () => {
      humanConfirmations[1]!();
      await settleMountedOperation();
      expect(state.mutationApplied).toBe(true);
    });
    expect(provider.fetch.mock.calls.filter(([input, init]) => providerUrl(input).pathname === '/v1/convai/agents/create' && init?.method === 'POST')).toHaveLength(1);
  });

  it('dismisses a pending confirmation on unmount without execute/CAS', async () => {
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = await mountActionView(<VoiceProviderSettingsActions
        providerId={PROVIDER_ID}
        owner={owner}
        actions={[action]}
        placement={{ kind: 'afterField', fieldId: 'agentId' }}
      />);
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      tree.unmount();
    });
    await flushHookEffects({ cycles: 1, turns: 4, frames: 1 });
    expect(hasConfirmation()).toBe(false);
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(state.mutationApplied).toBe(false);
  });

  it('allows a remounted action lifecycle to replace an abort-ignoring invocation under the same registration token', async () => {
    const stale = createDeferred<ReturnType<typeof provider.response>>();
    const replacement = createDeferred<ReturnType<typeof provider.response>>();
    const staleCreationEntered = createDeferred<void>();
    const replacementCreationEntered = createDeferred<void>();
    const http = provider.fetch.getMockImplementation()!;
    let creations = 0;
    provider.fetch.mockImplementation(async (input, init) => {
      const url = providerUrl(input);
      if (init?.method === 'GET' && ['replacement-agent', 'stale-agent'].some(id => url.pathname === `/v1/convai/agents/${id}`)) {
        const authored = await http(new URL('/v1/convai/agents/agent_created', url.origin), init);
        const body: unknown = await authored.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected authored Agent HTTP state');
        return provider.response({ ...body, agent_id: url.pathname.split('/').at(-1) });
      }
      if (providerUrl(input).pathname !== '/v1/convai/agents/create') return await http(input, init);
      creations += 1;
      (creations === 1 ? staleCreationEntered : replacementCreationEntered).resolve();
      const response = await (creations === 1 ? stale.promise : replacement.promise);
      await http(input, init);
      return response;
    });
    const { VoiceProviderSettingsActions } = await import('./VoiceProviderSettingsActions');
    const props = {
      providerId: PROVIDER_ID,
      owner,
      actions: [action],
      placement: { kind: 'afterField' as const, fieldId: 'agentId' },
    };
    let staleTree!: renderer.ReactTestRenderer;
    await act(async () => {
      staleTree = await mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      staleTree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(1);
    await act(async () => {
      humanConfirmations[0]!();
      await staleCreationEntered.promise;
      expect(creations).toBe(1);
    });
    const staleOperation = mountedOperation();
    await act(async () => {
      staleTree.unmount();
    });

    let replacementTree!: renderer.ReactTestRenderer;
    await act(async () => {
      replacementTree = await mountActionView(<VoiceProviderSettingsActions {...props} />);
    });
    await act(async () => {
      replacementTree.root.findByProps({ testID: 'voice-settings-action-create-agent' }).props.onPress();
    });
    await waitForConfirmation(2);
    await act(async () => {
      humanConfirmations[1]!();
      await replacementCreationEntered.promise;
      expect(creations).toBe(2);
    });

    replacement.resolve(provider.response({ agent_id: 'replacement-agent' }));
    await act(async () => {
      await settleMountedOperation();
      expect(state.config.agentId).toBe('replacement-agent');
    });
    stale.resolve(provider.response({ agent_id: 'stale-agent' }));
    await act(async () => {
      await staleOperation;
    });
    expect(state.config.agentId).toBe('replacement-agent');
    expect(nativeAlert).not.toHaveBeenCalled();
  });
});
