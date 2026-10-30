import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Native discovery and transport boundaries must register before Account/Sync consumers.
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';

import {
  VoiceProviderContributionSchema,
  type VoiceProviderSettingsJsonValueV1,
} from '@happier-dev/protocol';
import { VoiceProviderCatalogResponseSchema } from '@happier-dev/protocol/voice/providerOperations';
import { DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen as renderAppScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { getStorage as getActualStorage, storage } from '@/sync/domains/state/storageStore';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from '../voiceSettingsAccountTestHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { applyAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { settingsParse } from '@/sync/domains/settings/settings';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import {
  readLocalConversationVoiceSettings,
  readVoiceProviderSettingsConfig,
  voiceSettingsDefaults,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
  writeVoiceProviderSettingsConfig,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { PLUGIN_MANIFEST as OPENAI_COMPAT_MANIFEST } from '../../../../../../../packages/plugins/openai-compat/src/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_COMPAT_PRESENTATIONS } from '../../../../../../../packages/plugins/openai-compat/src/ui/voice/entries';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
  replaceExternalVoiceProviderProjectionAuthority,
  type ExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const executeSettingsAction = vi.hoisted(() => vi.fn());
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: () => ({
  home: { id: account.scope.serverId, serverUrl: getAppliedActiveServerSnapshot().serverUrl }, credentials: account.credentials,
}) });
const synthesize = speechBoundary.speechSynthesizeRpc;
let playbackFilesystem: ReturnType<typeof speechBoundary.reset>['filesystem'];
// The actual shared relay owner requires both its enabled bit and advertised caps.
const speechFeatures = FeaturesResponseSchema.parse({ features: {
  voice: { enabled: true },
  machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
}, capabilities: { machines: { liveStream: { serverRouted: { disabledReason: null, caps: {
  maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000,
  maxDurationMs: 60_000, maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
  maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
} } } } } });
const initialStorage = storage.getState();
const settingsActionState = {
  get voice() { return storage.getState().settings.voice; },
  set voice(value: unknown) { account.replaceVoice(voiceSettingsParse(value)); },
  get settingsScope() { return storage.getState().settingsScope; },
  set settingsScope(value: ReturnType<typeof storage.getState>['settingsScope']) { storage.setState({ settingsScope: value }); },
};
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

type CatalogRows = readonly Readonly<{
  id: string;
  name: string;
  metadata: Readonly<Record<string, unknown>>;
}>[];

const GOOGLE_GEMINI_STT_ID = 'happier.voice.google/gemini-stt';
const GOOGLE_CLOUD_TTS_ID = 'happier.voice.google/google-cloud-tts';
const OPENAI_COMPAT_TTS_ID = 'happier.voice.openai-compat/tts';

function voiceWithRootProviderConfig(
  providerId: string,
  config: VoiceProviderSettingsJsonValueV1,
): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    providers: {
      ...voiceSettingsDefaults.providers,
      [providerId]: { schemaVersion: 2, config },
    },
  };
}

function localConversationVoiceWithSttProvider(
  providerId: string,
  config: VoiceProviderSettingsJsonValueV1,
): VoiceSettings {
  const withSpeechConfig = voiceWithRootProviderConfig(providerId, config);
  const localConversation = readLocalConversationVoiceSettings(withSpeechConfig);
  return writeLocalConversationVoiceSettings({
    ...withSpeechConfig,
    providerId: 'local_conversation',
  }, {
    ...localConversation,
    stt: {
      ...localConversation.stt,
      provider: providerId,
    },
  });
}

function registerExternalSettingsOwner(
  pluginId: string,
  localId: string,
  descriptor: ReturnType<ReturnType<typeof createVoiceProviderRegistry>['get']>,
  settingsActions?: ExternalVoiceProviderRegistration['settingsActions'],
): void {
  if (!descriptor) throw new Error('expected external Voice descriptor');
  const token = {};
  const registration = {
    token,
    pluginId,
    localId,
    providerId: `${pluginId}/${localId}`,
    descriptor,
    adapter: null,
  };
  commitExternalVoiceProviderRegistration(settingsActions
    ? { ...registration, occurrenceId: `${pluginId}-occurrence`, settingsActions }
    : registration);
  onTestFinished(() => removeExternalVoiceProviderRegistration(token));
}

function parseSpeechDeclaration(input: unknown) {
  const declaration = VoiceProviderContributionSchema.parse(input);
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  return declaration;
}

const openAiCompatTtsEntry = createVoiceProviderRegistry({
  bundledContributions: [{
    pluginId: 'happier.voice.openai-compat',
    providerId: OPENAI_COMPAT_TTS_ID,
    declaration: parseSpeechDeclaration({
      id: 'tts',
      title: 'OpenAI-compatible Text-to-Speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web', 'ios', 'android'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.synthesize', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'baseUrl',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'insecureLocalOriginConsent',
            title: 'Local endpoint consent',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'insecureLocalConsentMachineId',
            title: 'Local endpoint consent machine',
            schema: { type: 'string', minLength: 0, maxLength: 512 },
            default: '',
            presentation: { control: 'text', hidden: true },
          },
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'tts-1',
            presentation: { control: 'text' },
          },
          {
            id: 'voiceName',
            title: 'Voice',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'alloy',
            presentation: { control: 'text' },
          },
          {
            id: 'format',
            title: 'Format',
            schema: { type: 'string', enum: ['mp3', 'wav'] },
            default: 'mp3',
            presentation: {
              control: 'select',
              options: [{ value: 'mp3', title: 'MP3' }, { value: 'wav', title: 'WAV' }],
            },
          },
        ],
        readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
      },
    }),
  }],
  bundledPresentations: [{
    providerId: OPENAI_COMPAT_TTS_ID,
    settingsSectionId: 'voice.tts.openai_compat',
    createSettingsSpec: () => ({
        titleKey: 'settingsVoice.local.openaiCompatTts.provider.title',
        subtitleKey: 'settingsVoice.local.openaiCompatTts.provider.subtitle',
        detailKey: 'settingsVoice.local.openaiCompatTts.provider.detail',
        iconName: 'cloud',
        credential: {
          titleKey: 'settingsVoice.local.ttsApiKey',
          promptTitleKey: 'settingsVoice.local.ttsApiKeyTitle',
          promptBodyKey: 'settingsVoice.local.ttsApiKeyDescription',
        },
            fields: [
              {
                fieldId: 'baseUrl',
                titleKey: 'settingsVoice.local.ttsBaseUrl',
                subtitleKey: 'settingsVoice.local.ttsBaseUrlDescription',
              },
              {
                fieldId: 'model',
            titleKey: 'settingsVoice.local.ttsModel',
            subtitleKey: 'settingsVoice.local.ttsModelSubtitle',
          },
          {
            fieldId: 'voiceName',
            titleKey: 'settingsVoice.local.ttsVoice',
            subtitleKey: 'settingsVoice.local.ttsVoiceSubtitle',
          },
          {
            fieldId: 'format',
            titleKey: 'settingsVoice.local.ttsFormat',
            subtitleKey: 'settingsVoice.local.ttsFormatSubtitle',
          },
        ],
        test: { missingValueMessageKey: 'settingsVoice.local.testTtsMissingBaseUrl' },
      }),
  }],
}).get(OPENAI_COMPAT_TTS_ID)!;

const fetchCatalog = vi.hoisted(() => vi.fn(
  async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
    ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
    : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }],
));
const executionMachine = {
  currentId: 'machine-a' as string | null,
  currentLabel: 'Machine A' as string | null,
  get machineId() { return this.currentId; },
  set machineId(value: string | null) {
    this.currentId = value;
    const machine = value ? createMachineFixture({ id: value, activeAt: Date.now(),
      metadata: { ...createMachineFixture().metadata!, displayName: this.currentLabel ?? undefined },
    }) : null;
    storage.setState({ machines: machine ? { [machine.id]: machine } : {},
      machineListByServerId: { [account.scope.serverId]: machine ? [machine] : [] },
    });
  },
  get machineLabel() { return this.currentLabel; },
  set machineLabel(value: string | null) {
    this.currentLabel = value;
    this.machineId = this.currentId;
  },
};
const connectedAccountSelection = Object.freeze({
  kind: 'connectedAccount' as const,
  target: Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({
      service: Object.freeze({ pluginId: 'acme.speech', localId: 'account' }),
      accountId: 'account-a',
    }),
  }),
});

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Registry collection resolves this vendor leaf; these speech settings never start a conversation.
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: () => {
  throw new Error('Unexpected ElevenLabs conversation in speech settings');
} } }));

/** Inspect the real manifest row's field while keeping its control mounted. */
function rowField(rendered: Awaited<ReturnType<typeof renderScreen>>, title: string): React.ReactElement<{
  value: string; onChangeText(value: string): void; onBlur(): void;
}> {
  const row = rendered.tree.root.findAll(node => node.props.rightElement !== undefined)
    .find((node) => node.props.title === tLoose(title) && node.props.rightElement !== undefined);
  if (!row) throw new Error(`missing field row ${title}`);
  return row.props.rightElement;
}

async function typeIntoRow(rendered: Awaited<ReturnType<typeof renderScreen>>, title: string, text: string) {
  await act(async () => { rowField(rendered, title).props.onChangeText(text); });
  await act(async () => { rowField(rendered, title).props.onBlur(); });
}

// Install HTTP/Socket before loading real controls and Sync consumers.
await loadSyncSingletonForTests();
const { Alert } = await import('react-native');
const nativeAlert = vi.spyOn(Alert, 'alert');
const { tLoose, setPreferredLanguageFromSettings } = await import('@/text');
const { ModalProvider, useOptionalModal } = await import('@/modal');
let modalContext: ReturnType<typeof useOptionalModal>;
function ModalStateProbe() {
  modalContext = useOptionalModal();
  return null;
}
function SpeechSettingsTestProviders({ children }: React.PropsWithChildren) {
  return React.createElement(ModalProvider, { children: React.createElement(React.Fragment, null,
    React.createElement(ModalStateProbe), children,
  ) });
}
function renderScreen(element: Parameters<typeof renderAppScreen>[0]) {
  return renderAppScreen(element, { wrapper: SpeechSettingsTestProviders });
}
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { VoiceCredentialItem } = await import('@/voice/credentials/CredentialItem');
const CredentialComponent = Reflect.get(VoiceCredentialItem, 'type') as React.ComponentType<React.ComponentProps<typeof VoiceCredentialItem>>;
const { VoiceRawCredentialAccessReview } = await import('@/voice/credentials/VoiceRawCredentialAccessReview');
const { VoiceCredentialSourceField } = await import('../realtime/VoiceCredentialSourceField');
await import('./BundledSpeechSettings');

async function saveCredential(providerId: string, secretId = 'account-secret-a') {
  const entry = createDefaultVoiceProviderRegistry().get(providerId);
  if (entry?.kind !== 'voice.speech-engine.v1' || !entry.declaration) throw new Error('Expected speech credential declaration');
  account.replaceSettings(await withVoiceSettingsCredentialResource(account, {
    settings: account.settings, declaration: entry.declaration, pluginId: entry.pluginId, resourceId: secretId,
    recipientContractDigest: entry.accountCredentialSlot?.recipientContractDigest,
  }));
  await refreshSavedSecretCatalog(account.scope);
}

async function selectCredentialSource(entry: NonNullable<ReturnType<ReturnType<typeof createVoiceProviderRegistry>['get']>>,
  selection: typeof connectedAccountSelection | Readonly<{ kind: 'none' | 'savedSecret' }>) {
  if (entry.kind === 'voice.turn-support.v1' || !entry.declaration?.credentials) throw new Error('Missing credential declaration');
  const result = applyAccountVoiceCredentialSourceSelection({ settings: account.settings,
    connectedPurposes: account.purposes.value, currentDeclaration: entry.declaration,
    mutation: { contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
      credentialSlotId: entry.declaration.credentials.slot.id,
      selection, expectedSettingsVersion: storage.getState().settingsVersion ?? 1 },
  });
  account.replaceSettings(result.settings);
  await account.replaceConnectedPurposes(result.connectedPurposes);
}

describe('BundledSpeechSettings', () => {
  it.each(['execution machine', 'Account', 'provider', 'retired provider', 'retired projection', 'unrelated settings', 'installed first-party'] as const)('applies an endpoint approval only to its current context while retaining unrelated changes: %s', async (change) => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const entry = createDefaultVoiceProviderRegistry().get(OPENAI_COMPAT_TTS_ID);
    if (!entry?.providerSettings) throw new Error('missing canonical speech entry');
    const registrationToken = {};
    commitExternalVoiceProviderRegistration({
      token: registrationToken, pluginId: entry.pluginId, localId: 'tts', providerId: entry.providerId,
      descriptor: change === 'installed first-party'
        ? Object.freeze({ ...entry, settingsSectionId: entry.providerId,
            source: Object.freeze({ kind: 'external' as const, pluginId: entry.pluginId, localId: 'tts' }) })
        : entry,
      adapter: null, occurrenceId: 'speech-occurrence',
    });
    onTestFinished(() => removeExternalVoiceProviderRegistration(registrationToken));
    if (change === 'retired projection') replaceExternalVoiceProviderProjectionAuthority(
      null, registrationToken, new Map([[entry.providerId, 'speech-occurrence']]),
    );
    const spec = createBundledLocalTtsProviderSpec(entry);
    if (!spec) throw new Error('missing real speech settings panel');
    const voice = { ...voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
      ...entry.providerSettings.defaultConfig,
      baseUrl: 'https://speech.example/v1', insecureLocalOriginConsent: '', insecureLocalConsentMachineId: '',
      model: 'tts-1', voiceName: 'alloy', format: 'mp3',
    }), executionMachine: { mode: 'fixed' as const, machineId: 'machine-a' } };
    settingsActionState.voice = voice;
    const setVoice = vi.fn();
    const rendered = await renderScreen(React.createElement(spec.Settings, {
      cfgTts: VoiceLocalTtsSchema.parse({ provider: OPENAI_COMPAT_TTS_ID }), setTts: vi.fn(), voice, setVoice, popoverBoundaryRef: null, networkTimeoutMs: 15_000,
    }));
    let approveEndpoint: (() => void) | undefined;
    const endpointApprovalPresented = createDeferred<void>();
    nativeAlert.mockImplementationOnce((_title, _message, buttons) => {
      approveEndpoint = buttons?.find(button => button.style !== 'cancel')?.onPress;
      endpointApprovalPresented.resolve();
    });
    expect(rendered.tree.root.findAllByType(CredentialComponent)[0]?.props.machineId).toBe('machine-a');
    await act(async () => { rowField(rendered, 'settingsVoice.local.ttsBaseUrl').props.onChangeText('http://localhost:11434/v1'); });
    expect(rowField(rendered, 'settingsVoice.local.ttsBaseUrl').props.value).toBe('http://localhost:11434/v1');
    await act(async () => { rowField(rendered, 'settingsVoice.local.ttsBaseUrl').props.onBlur(); });
    await endpointApprovalPresented.promise;
    expect(approveEndpoint).toBeTypeOf('function');
    if (change === 'execution machine') {
      executionMachine.machineId = 'machine-b';
      executionMachine.machineLabel = 'Machine B';
    } else if (change === 'Account') {
      settingsActionState.settingsScope = { serverId: 'server-1', accountId: 'account-2' };
    } else if (change === 'provider') {
      const other = createBundledLocalTtsProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID)!);
      if (!other) throw new Error('missing other real speech provider');
      await rendered.update(React.createElement(other.Settings, {
        cfgTts: VoiceLocalTtsSchema.parse({ provider: GOOGLE_CLOUD_TTS_ID }), setTts: vi.fn(), voice, setVoice, popoverBoundaryRef: null, networkTimeoutMs: 15_000,
      }));
    } else if (change === 'retired provider') {
      // Retire the real activation record without rerendering the pending field.
      await act(async () => removeExternalVoiceProviderRegistration(registrationToken));
    } else if (change === 'retired projection') {
      // Retire admission while retaining the same activation registration.
      await act(async () => replaceExternalVoiceProviderProjectionAuthority(null, registrationToken, new Map()));
    } else {
      settingsActionState.voice = writeVoiceProviderSettingsConfig(voice, OPENAI_COMPAT_TTS_ID, {
        ...entry.providerSettings.defaultConfig, baseUrl: 'https://speech.example/v1', model: 'new-model',
      });
    }
    await act(async () => { approveEndpoint!(); });
    // After the modal decision this owner only has promise continuations and React work;
    // drain them through the canonical testkit before checking a stale-context no-write.
    await flushHookEffects();
    if (change === 'unrelated settings' || change === 'installed first-party') {
      expect(setVoice).toHaveBeenLastCalledWith(expect.objectContaining({ providers: expect.objectContaining({
        [OPENAI_COMPAT_TTS_ID]: expect.objectContaining({ config: expect.objectContaining({
          baseUrl: 'http://localhost:11434/v1', insecureLocalOriginConsent: 'http://localhost:11434',
          insecureLocalConsentMachineId: 'machine-a', model: 'new-model',
        }) }),
      }) }));
    } else expect(setVoice.mock.calls.length).toBe(0);
  });
  beforeEach(async () => {
    playbackFilesystem = speechBoundary.reset().filesystem;
    const nativeMachineRpc = speechBoundary.machineRpc.getMockImplementation()!;
    speechBoundary.machineRpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG) return VoiceProviderCatalogResponseSchema.parse({
        ok: true, items: await fetchCatalog(request, request.payload.catalog),
      });
      // Raw recipient inspection is unavailable at this transport boundary.
      if (request.method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT) return DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
        ok: false, errorCode: 'unavailable',
      });
      return await nativeMachineRpc(request);
    });
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: voiceSettingsDefaults }), { features: speechFeatures });
    setRuntimeFetch(async (url, init) => speechBoundary.answerMachineHttpRequest(url, executionMachine.currentId ?? 'machine-a', 'account-a', init)
      ?? await account.request(url, init));
    executionMachine.machineId = 'machine-a';
    executionMachine.machineLabel = 'Machine A';
    fetchCatalog.mockReset();
    fetchCatalog.mockImplementation(async (_entry: unknown, catalog: string): Promise<CatalogRows> => catalog === 'models'
      ? [{ id: 'gemini-test', name: 'Gemini Test', metadata: {} }]
      : [{ id: 'en-US-Test-A', name: 'English Test', metadata: {} }]);
    nativeAlert.mockReset();
    // Only native presentation is substituted. Each endpoint case separately
    // chooses the real ModalManager's approval button after changing context.
    synthesize.mockReset();
    synthesize.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' });
    executeSettingsAction.mockReset();
    settingsActionState.voice = voiceSettingsDefaults;
    await saveCredential(GOOGLE_GEMINI_STT_ID);
    setPreferredLanguageFromSettings('en');
    modalContext = undefined;
  });
  afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    speechBoundary.disposeNativeSdkBridge();
    storage.setState(initialStorage, true);
  });
  afterAll(async () => {
    await speechBoundary.disposeAudioSession();
    nativeAlert.mockRestore();
  });

  it('admits speech voice catalog loading and Retry through Settings Actions', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const entry = createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID)!;
    const spec = createBundledLocalTtsProviderSpec(entry)!;
    const base = voiceWithRootProviderConfig(GOOGLE_CLOUD_TTS_ID, { voiceName: 'en-US-Test-A', languageCode: '', format: 'mp3', speakingRate: 1, pitch: 0 });
    const local = readLocalConversationVoiceSettings(base);
    const voice = writeLocalConversationVoiceSettings({ ...base, providerId: 'local_conversation' }, {
      ...local, tts: { ...local.tts, provider: GOOGLE_CLOUD_TTS_ID },
    });
    account.replaceSettings(settingsParse({ ...account.settings, voice, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: false } } } }));
    const rendered = await renderScreen(React.createElement(spec.Settings, {
      cfgTts: VoiceLocalTtsSchema.parse({ provider: GOOGLE_CLOUD_TTS_ID }), setTts: vi.fn(),
      voice, setVoice: vi.fn(), networkTimeoutMs: 15_000, popoverBoundaryRef: null,
    }));
    await flushHookEffects();
    expect(fetchCatalog).not.toHaveBeenCalled();
    const voiceMenu = () => rendered.tree.root.findAllByType(DropdownMenu)
      .find(row => row.props.items.some((item: { id: string }) => item.id === '__retry__'))!;
    await waitForTestEvent(rendered.tree.subscribe, voiceMenu, menu => menu !== undefined);
    expect(voiceMenu()).toBeDefined();
    account.replaceSettings(settingsParse({ ...account.settings, actionsSettingsV1: { v: 1,
      actions: { 'settings.invoke': { enabled: true } } } }));
    await act(async () => voiceMenu().props.onSelect('__retry__'));
    await waitForTestEvent(rendered.tree.subscribe,
      () => rendered.tree.root.findAllByType(DropdownMenu).flatMap(row => row.props.items),
      items => items.some((item: { id: string }) => item.id === 'en-US-Test-A'));
    expect(fetchCatalog).toHaveBeenCalled();
    expect(rendered.tree.root.findAllByType(DropdownMenu).flatMap(row => row.props.items))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'en-US-Test-A', title: 'English Test' })]));
  });

  it('renders package-owned STT fields and writes the provider envelope', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    expect(spec).not.toBeNull();
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: { [GOOGLE_GEMINI_STT_ID]: { schemaVersion: 2, config: { model: 'gemini-2.5-flash', language: null } } },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));
    await act(async () => undefined);
    const model = rendered.tree.root.findAllByType(DropdownMenu)
      .find((row) => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'));
    expect(model).toBeTruthy();
    await act(async () => model!.props.onSelect('gemini-test'));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [GOOGLE_GEMINI_STT_ID]: {
          schemaVersion: 2,
          config: expect.objectContaining({ model: 'gemini-test' }),
        },
      },
    }));
  });

  it('invokes a declared speech settings action from the real bundled STT panel and persists its patch', async () => {
    const providerId = 'acme.external/action-stt';
    const declaration = parseSpeechDeclaration({
      id: 'action-stt',
      title: 'Action Speech-to-Text',
      kind: 'speech',
      roles: ['conversation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
        actions: [{
          id: 'refresh-model',
          title: 'Refresh model',
          placement: { kind: 'contributionFooter' },
          confirmation: { kind: 'none' },
          patchFieldIds: ['model'],
        }],
      },
    });
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration,
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'Action Speech-to-Text',
          subtitleKey: 'Action Speech-to-Text',
          detailKey: 'Action Speech-to-Text',
          iconName: 'extension',
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'action-stt', entry, {
      execute: async ({ actionId, signal }) => await executeSettingsAction({
        entry,
        actionId,
        signal,
      }),
    });
    expect(createDefaultVoiceProviderRegistry().get(providerId)).toBe(entry);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    if (!spec) throw new Error('speech settings spec is required');
    const voice = localConversationVoiceWithSttProvider(providerId, { model: 'speech-1' });
    settingsActionState.voice = voice;
    const settingsStore = getActualStorage();
    const previousSettingsScope = settingsStore.getState().settingsScope;
    onTestFinished(() => settingsStore.setState({ settingsScope: previousSettingsScope }));
    const rendered = await renderScreen(React.createElement(spec.Settings, {
      cfgStt: {
        provider: providerId,
        providers: {
          [providerId]: {
            schemaVersion: 2,
            config: { model: 'speech-1' },
          },
        },
      },
      setStt: vi.fn(),
      voice,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));
    const action = rendered.tree.root.findByProps({
      testID: 'voice-settings-action-refresh-model',
    });

    const actionResponse = createDeferred<{ patch: { model: string } }>();
    const actionEntered = createDeferred<void>();
    const patchApplied = createDeferred<void>();
    const unsubscribe = storage.subscribe(snapshot => {
      if (readVoiceProviderSettingsConfig(snapshot.settings.voice, providerId)?.model === 'speech-2') {
        unsubscribe();
        patchApplied.resolve();
      }
    });
    onTestFinished(unsubscribe);
    executeSettingsAction.mockImplementationOnce(() => {
      actionEntered.resolve();
      return actionResponse.promise;
    });
    await act(async () => action.props.onPress());
    await waitForTestEvent(rendered.tree.subscribe, () => action.props.loading, loading => loading === true);
    expect(action.props.loading).toBe(true);
    await waitForTestEvent(rendered.tree.subscribe,
      () => rendered.tree.findByTestId('app-shell-confirmation-confirm'), button => button !== null);
    expect(rendered.tree.findByTestId('app-shell-confirmation-confirm')).not.toBeNull();
    await rendered.tree.pressByTestIdAsync('app-shell-confirmation-confirm');
    await actionEntered.promise;
    expect(executeSettingsAction).toHaveBeenCalledOnce();
    await act(async () => {
      actionResponse.resolve({ patch: { model: 'speech-2' } });
    });
    await patchApplied.promise;
    await waitForTestEvent(account.subscribe,
      () => readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)?.model,
      model => model === 'speech-2');
    await flushHookEffects();
    await waitForTestEvent(rendered.tree.subscribe, () => action.props.loading, loading => loading === false);
    expect(action.props.loading).toBe(false);
    expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)).toEqual({ model: 'speech-2' });
    expect(executeSettingsAction).toHaveBeenCalledWith({
      entry,
      actionId: 'refresh-model',
      signal: expect.any(AbortSignal),
    });
    expect(account.writes.length).toBeGreaterThan(0);
    expect(readVoiceProviderSettingsConfig(account.persistedSettings.voice, providerId)).toEqual({ model: 'speech-2' });
    expect(readVoiceProviderSettingsConfig(settingsActionState.voice as VoiceSettings, providerId))
      .toEqual({ model: 'speech-2' });
  });

  it.each([
    ['missing', undefined],
    ['invalid', { schemaVersion: 2 as const, config: { model: 42 } }],
  ])('keeps %s canonical root settings inert instead of loading a remote catalog', async (_case, envelope) => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(
      createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!,
    );
    const { [GOOGLE_GEMINI_STT_ID]: _current, ...providers } = voiceSettingsDefaults.providers;
    const voice = {
      ...voiceSettingsDefaults,
      providers: {
        ...providers,
        ...(envelope ? { [GOOGLE_GEMINI_STT_ID]: envelope } : {}),
      },
    } as VoiceSettings;

    const setVoice = vi.fn();
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {},
      },
      setStt: vi.fn(),
      voice,
      setVoice,
      popoverBoundaryRef: null,
    }));
    await act(async () => undefined);

    expect(fetchCatalog).not.toHaveBeenCalled();
    const model = rendered.tree.root.findAllByType(DropdownMenu)
      .find((row) => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'));
    expect(model).toBeTruthy();
    act(() => model!.props.onSelect('gemini-test'));
    expect(setVoice).not.toHaveBeenCalled();
  });

  it('edits a bounded manifest text field inline and writes its canonical provider envelope', async () => {
    const declaration = parseSpeechDeclaration({
      id: 'stt-text',
      title: 'OpenAI-compatible Speech-to-Text',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web', 'ios', 'android'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'optional' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'endpointUrl',
            title: 'Endpoint',
            schema: { type: 'string', minLength: 0, maxLength: 2048 },
            default: '',
            presentation: { control: 'text' },
          },
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'whisper-1',
            presentation: { control: 'text' },
          },
        ],
      },
    });
    const providerId = 'acme.external/stt-text';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration,
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.openai_compat',
        createSettingsSpec: () => ({
            titleKey: 'settingsVoice.local.openaiCompatStt.provider.title',
            subtitleKey: 'settingsVoice.local.openaiCompatStt.provider.subtitle',
            detailKey: 'settingsVoice.local.openaiCompatStt.provider.detail',
            iconName: 'cloud',
            credential: {
              titleKey: 'settingsVoice.local.sttApiKey',
              promptTitleKey: 'settingsVoice.local.sttApiKeyTitle',
              promptBodyKey: 'settingsVoice.local.sttApiKeyDescription',
            },
            fields: [
              {
                fieldId: 'endpointUrl',
                titleKey: 'settingsVoice.local.sttBaseUrl',
                subtitleKey: 'settingsVoice.local.sttBaseUrlDescription',
                promptTitleKey: 'settingsVoice.local.sttBaseUrlTitle',
                promptBodyKey: 'settingsVoice.local.sttBaseUrlDescription',
              },
              {
                fieldId: 'model',
                titleKey: 'settingsVoice.local.sttModel',
                subtitleKey: 'settingsVoice.local.sttModelSubtitle',
              },
            ],
            test: null,
          }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'stt-text', entry);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(providerId, { endpointUrl: '', model: 'whisper-1' });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: providerId,
        providers: { [providerId]: { schemaVersion: 2, config: { endpointUrl: '' } } },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));
    await typeIntoRow(rendered, 'settingsVoice.local.sttBaseUrl', ' https://speech.example/v1 ');
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { endpointUrl: 'https://speech.example/v1', model: 'whisper-1' },
        },
      },
    }));

    await typeIntoRow(rendered, 'settingsVoice.local.sttModel', '');
    expect(nativeAlert.mock.calls[0]?.[0]).toBe(tLoose('common.error'));
    expect(setVoice).toHaveBeenCalledTimes(1);
    expect(rowField(rendered, 'settingsVoice.local.sttModel').props.value).toBe('whisper-1');
    expect(modalContext?.state.modals.filter(modal => modal.type === 'prompt')).toHaveLength(0);
  });

  it('edits a signed manifest number inline within its declared bounds', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID)!);
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(GOOGLE_CLOUD_TTS_ID, {
      voiceName: '', languageCode: '', format: 'mp3', speakingRate: 1, pitch: 0,
    });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: {
        provider: GOOGLE_CLOUD_TTS_ID,
        providers: { [GOOGLE_CLOUD_TTS_ID]: { schemaVersion: 2, config: { voiceName: null, languageCode: null, format: 'mp3', speakingRate: null, pitch: null } } },
      },
      setTts: vi.fn(),
      voice: voiceSettings,
      setVoice,
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    } as never));
    await act(async () => undefined);

    await typeIntoRow(rendered, 'settingsVoice.local.googleCloudTts.pitch.title', '25');
    expect(nativeAlert).toHaveBeenCalled();
    expect(setVoice).not.toHaveBeenCalled();

    await typeIntoRow(rendered, 'settingsVoice.local.googleCloudTts.pitch.title', '-2.5');
    expect(setVoice).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({
        [GOOGLE_CLOUD_TTS_ID]: expect.objectContaining({ config: expect.objectContaining({ pitch: -2.5 }) }),
      }),
    }));
    expect(modalContext?.state.modals.filter(modal => modal.type === 'prompt')).toHaveLength(0);
  });

  it('renders package-owned TTS fields and writes voice selection without a vendor panel', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_CLOUD_TTS_ID)!);
    expect(spec).not.toBeNull();
    const setTts = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(GOOGLE_CLOUD_TTS_ID, {
      voiceName: '', languageCode: '', format: 'mp3', speakingRate: 1, pitch: 0,
    });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: {
        provider: GOOGLE_CLOUD_TTS_ID,
        providers: { [GOOGLE_CLOUD_TTS_ID]: { schemaVersion: 2, config: { voiceName: null, languageCode: null, format: 'mp3', speakingRate: null, pitch: null } } },
      },
      setTts,
      voice: voiceSettings,
      setVoice,
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    } as never));
    await act(async () => undefined);
    const voice = rendered.tree.root.findAllByType(DropdownMenu)
      .find((row) => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleCloudTts.voice.searchPlaceholder'));
    expect(voice).toBeTruthy();
    await act(async () => voice!.props.onSelect('en-US-Test-A'));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [GOOGLE_CLOUD_TTS_ID]: {
          schemaVersion: 2,
          config: expect.objectContaining({ voiceName: 'en-US-Test-A' }),
        },
      },
    }));
  });

  it('renders and persists textarea, switch, and JSON controls without a credential placeholder', async () => {
    const declaration = parseSpeechDeclaration({
      id: 'speech',
      title: 'External Speech',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      settings: {
        schemaVersion: 2,
        fields: [
          {
            id: 'model',
            title: 'Model',
            schema: { type: 'string', minLength: 1, maxLength: 256 },
            default: 'whisper-1',
            presentation: { control: 'text' },
          },
          {
            id: 'instructions',
            title: 'Instructions',
            schema: { type: 'string', minLength: 0, maxLength: 10_000 },
            default: '',
            presentation: { control: 'textarea' },
          },
          {
            id: 'enhance',
            title: 'Enhance speech',
            schema: { type: 'boolean' },
            default: false,
            presentation: { control: 'switch' },
          },
          {
            id: 'metadata',
            title: 'Metadata',
            schema: { type: 'object', additionalProperties: true },
            default: {},
            presentation: { control: 'json' },
          },
        ],
      },
    });
    const providerId = 'acme.external/speech';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.external', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: providerId,
        createSettingsSpec: () => ({
          titleKey: 'External Speech',
          subtitleKey: 'External Speech',
          detailKey: 'External Speech',
          iconName: 'extension',
          fields: declaration.settings!.fields.map((field) => ({
            fieldId: field.id,
            titleKey: typeof field.title === 'string' ? field.title : field.title.key,
            subtitleKey: typeof field.title === 'string' ? field.title : field.title.key,
          })),
          test: null,
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'speech', entry);
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(entry);
    expect(spec).not.toBeNull();
    const setStt = vi.fn();
    const setVoice = vi.fn();
    const voiceSettings = voiceWithRootProviderConfig(providerId, {
      model: 'whisper-1', instructions: '', enhance: false, metadata: {},
    });
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: providerId,
        providers: {
          [providerId]: {
            schemaVersion: 2,
            config: { instructions: '', enhance: false, metadata: {} },
          },
        },
      },
      setStt,
      voice: voiceSettings,
      setVoice,
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findAllByType(CredentialComponent)).toHaveLength(0);
    const instructions = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:instructions.input',
    });
    const instructionsSave = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:instructions.save',
    });
    const enhance = rendered.tree.root.findAll(node => node.props.rightElement !== undefined)
      .find((row) => row.props.title === 'Enhance speech')!;
    const metadata = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:metadata.input',
    });
    const metadataSave = rendered.tree.root.findByProps({
      testID: 'voice-speech-setting:metadata.save',
    });

    act(() => instructions.props.onChangeText('Keep punctuation.'));
    await act(async () => instructionsSave.props.onPress());
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: 'Keep punctuation.', enhance: false, metadata: {} },
        },
      },
    }));

    expect(enhance.props.rightElement.props.testID).toBe('voice-speech-setting:enhance.switch');
    act(() => enhance.props.rightElement.props.onValueChange(true));
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: '', enhance: true, metadata: {} },
        },
      },
    }));

    act(() => metadata.props.onChangeText('{"locale":"en"}'));
    await act(async () => metadataSave.props.onPress());
    expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
      providers: {
        ...voiceSettings.providers,
        [providerId]: {
          schemaVersion: 2,
          config: { model: 'whisper-1', instructions: '', enhance: false, metadata: { locale: 'en' } },
        },
      },
    }));

    setVoice.mockClear();
    nativeAlert.mockClear();
    act(() => metadata.props.onChangeText('{'));
    await act(async () => metadataSave.props.onPress());
    expect(setVoice).not.toHaveBeenCalled();
    expect(nativeAlert).toHaveBeenCalledOnce();

    nativeAlert.mockClear();
    act(() => metadata.props.onChangeText('[]'));
    await act(async () => metadataSave.props.onPress());
    expect(setVoice).not.toHaveBeenCalled();
    expect(nativeAlert).toHaveBeenCalledOnce();
  });

  it('validates descriptor-configured OpenAI-compatible TTS settings without carrying them over RPC', async () => {
    let playedBytes: Uint8Array | undefined;
    speechBoundary.encodedAudio.start.mockImplementationOnce(async uri => {
      playedBytes = playbackFilesystem.files.get(uri)?.slice();
      speechBoundary.encodedAudio.emit('started');
      speechBoundary.encodedAudio.emit('finished');
    });
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const entry = createVoiceProviderRegistry({
      bundledContributions: (OPENAI_COMPAT_MANIFEST.contributes.voiceProviders ?? []).map((value) => VoiceProviderContributionSchema.parse(value)).map((declaration) => ({
        pluginId: OPENAI_COMPAT_MANIFEST.id, providerId: `${OPENAI_COMPAT_MANIFEST.id}/${declaration.id}`, declaration,
      })), bundledPresentations: OPENAI_COMPAT_PRESENTATIONS,
    }).get(OPENAI_COMPAT_TTS_ID);
    if (!entry || entry.kind !== 'voice.speech-engine.v1' || !entry.declaration || !entry.providerSettings) throw new Error('missing canonical speech entry');
    const spec = createBundledLocalTtsProviderSpec(entry);

    const voiceSettings = voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
      ...entry.providerSettings.defaultConfig,
      baseUrl: 'https://speech.example/v1',
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
      model: '  tts-1-hd  ',
      voiceName: 'alloy',
      format: 'mp3',
    });
    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({
        provider: OPENAI_COMPAT_TTS_ID,
        providers: {
          [OPENAI_COMPAT_TTS_ID]: {
            schemaVersion: 2,
            config: {
              baseUrl: 'https://speech.example/v1',
              model: '  tts-1-hd  ',
              voiceName: 'alloy',
              format: 'mp3',
            },
          },
        },
      }),
      voice: voiceSettings,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: entry.pluginId, localId: entry.declaration!.id },
      input: 'Hello',
    }));
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('voiceName');
    expect(speechBoundary.encodedAudio.start).toHaveBeenCalledTimes(1);
    expect(playedBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(speechBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it('validates contribution catalog correspondence without carrying it over RPC', async () => {
    const providerId = 'acme.external/catalog-tts';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.external',
        providerId,
        declaration: parseSpeechDeclaration({
          id: 'catalog-tts',
          title: 'Catalog Text-to-Speech',
          kind: 'speech',
          roles: ['conversation_tts'],
          platforms: ['web', 'ios', 'android'],
          settings: {
            schemaVersion: 2,
            fields: [
              {
                id: 'selectedModel',
                title: 'Model',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'model-default',
                presentation: { control: 'select' },
              },
              {
                id: 'selectedVoice',
                title: 'Voice',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'voice-default',
                presentation: { control: 'select' },
              },
              {
                id: 'format',
                title: 'Format',
                schema: { type: 'string', enum: ['wav'] },
                default: 'wav',
                presentation: { control: 'select', options: [{ value: 'wav', title: 'WAV' }] },
              },
            ],
          },
          catalogs: [
            { kind: 'models', settingFieldId: 'selectedModel', allowCustom: true },
            { kind: 'voices', settingFieldId: 'selectedVoice', allowCustom: true },
          ],
        }),
      }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.tts.catalog',
        createSettingsSpec: () => ({
          titleKey: 'settingsVoice.local.openaiCompatTts.provider.title',
          subtitleKey: 'settingsVoice.local.openaiCompatTts.provider.subtitle',
          detailKey: 'settingsVoice.local.openaiCompatTts.provider.detail',
          iconName: 'cloud',
          fields: [
            {
              fieldId: 'selectedModel',
              titleKey: 'settingsVoice.local.ttsModel',
              subtitleKey: 'settingsVoice.local.ttsModelSubtitle',
            },
            {
              fieldId: 'selectedVoice',
              titleKey: 'settingsVoice.local.ttsVoice',
              subtitleKey: 'settingsVoice.local.ttsVoiceSubtitle',
            },
            {
              fieldId: 'format',
              titleKey: 'Format',
              subtitleKey: 'Format',
            },
          ],
          test: { missingValueMessageKey: 'settingsVoice.local.testTtsMissingVoice' },
        }),
      }],
    }).get(providerId)!;
    registerExternalSettingsOwner('acme.external', 'catalog-tts', entry);
    if (entry.kind !== 'voice.speech-engine.v1' || !entry.declaration) throw new Error('Expected declared catalog TTS fixture');
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(entry);
    const voice = voiceWithRootProviderConfig(providerId, {
      selectedModel: '  catalog-model  ',
      selectedVoice: '  catalog-voice  ',
      format: 'wav',
    });

    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({ provider: providerId }),
      voice,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: entry.pluginId, localId: entry.declaration!.id },
      input: 'Hello',
    }));
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(synthesize.mock.calls[0]?.[0]).not.toHaveProperty('voiceName');
  });

  it('uses the descriptor-owned field as the TTS test prerequisite', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);

    const voiceSettings = voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
      baseUrl: '   ', insecureLocalOriginConsent: '', model: 'tts-1', voiceName: 'alloy', format: 'mp3',
    });
    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({
        provider: OPENAI_COMPAT_TTS_ID,
        providers: {
          [OPENAI_COMPAT_TTS_ID]: {
            schemaVersion: 2,
            config: {
              baseUrl: '   ',
              model: 'tts-1',
              voiceName: 'alloy',
              format: 'mp3',
            },
          },
        },
      }),
      voice: voiceSettings,
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(nativeAlert.mock.calls[0]?.slice(0, 2)).toEqual([tLoose('common.error'), tLoose('settingsVoice.local.testTtsMissingBaseUrl')]);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('does not test TTS from descriptor defaults when the canonical root envelope is absent', async () => {
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);
    const { [OPENAI_COMPAT_TTS_ID]: _missing, ...providers } = voiceSettingsDefaults.providers;

    await spec!.test({
      cfgTts: VoiceLocalTtsSchema.parse({ provider: OPENAI_COMPAT_TTS_ID }),
      voice: { ...voiceSettingsDefaults, providers },
      networkTimeoutMs: 15_000,
      sample: 'Hello',
    });

    expect(nativeAlert.mock.calls[0]?.slice(0, 2)).toEqual([tLoose('common.error'), tLoose('settingsVoice.local.testTtsMissingBaseUrl')]);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('marks selected-machine Google STT credentials for plain-account disclosure', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {
          [GOOGLE_GEMINI_STT_ID]: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      voice: voiceSettings,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));
    const credential = rendered.tree.root.findByType(CredentialComponent);
    expect(credential.props).toMatchObject({
      contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      credentialSlotId: 'api_key',
      credentialSourcePurpose: 'voice.speech.transcribe',
      disclosePlainStorage: true,
    });
    expect(credential.props).toHaveProperty('machineId');
    expect(credential.props).not.toHaveProperty('operations');
  });

  it('passes an admitted mediated speech recipient contract to the canonical credential approval surface', async () => {
    const { normalizeRecipientContractV1, createRecipientContractDigestV1 } = await import('@happier-dev/protocol');
    const recipientContract = normalizeRecipientContractV1({ version: 1,
      package: { pluginId: openAiCompatTtsEntry.pluginId, source: { kind: 'package', locator: '@acme/speech' } },
      publisher: { trust: 'verified', identity: 'npm:acme' },
      contribution: { pluginId: openAiCompatTtsEntry.pluginId, localId: 'tts' },
      credentialSlot: { id: 'api_key', scope: 'account' },
      operations: [{ id: 'catalog', purpose: 'voice.speech.catalog', credentialSlotId: 'api_key', effect: 'read',
        request: { origin: 'https://speech.example', pathTemplate: '/v1/voices', method: 'GET',
          queryTemplate: [], headerTemplate: [], bodyTemplate: { kind: 'none' },
          credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' }, redirect: 'error',
          maxBodyBytes: 0, contentTypes: [] },
        parameters: { schema: { type: 'object', properties: {}, additionalProperties: false }, mapping: [] },
        response: { maxBytes: 32768, contentTypes: ['application/json'] },
      }],
    });
    const recipientContractDigest = createRecipientContractDigestV1(recipientContract);
    const entry = Object.freeze({
      ...openAiCompatTtsEntry,
      accountCredentialSlot: Object.freeze({
        id: 'api_key',
        scope: 'account' as const,
        kind: 'apiKey' as const,
        recipientContract,
        recipientContractDigest,
      }),
    });
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(entry);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: VoiceLocalTtsSchema.parse({ provider: OPENAI_COMPAT_TTS_ID }),
      setTts: vi.fn(),
      voice: voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
        baseUrl: 'https://speech.example/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'tts-1',
        voiceName: 'alloy',
        format: 'mp3',
      }),
      setVoice: vi.fn(),
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findByType(CredentialComponent).props).toMatchObject({
      recipientContract,
      recipientContractDigest,
    });
  });

  it.each([
    ['a definitively selected Connected Account', connectedAccountSelection, undefined],
    ['an unresolved source selection', { kind: 'none' } as const, 'voice.speech.transcribe'],
  ])('routes multi-source speech SavedSecret edits through the source owner except for %s', async (
    _caseName,
    sourceSelection,
    expectedPurpose,
  ) => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const declaration = parseSpeechDeclaration({
      id: 'multi-source-stt',
      title: 'Multi-source STT',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }, {
          kind: 'connectedAccount',
          service: { pluginId: 'acme.speech', localId: 'account' },
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
      },
    });
    const providerId = 'acme.speech/multi-source-stt';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.speech', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.acme',
        createSettingsSpec: () => ({
          titleKey: 'Acme STT',
          subtitleKey: 'Acme STT subtitle',
          detailKey: 'Acme STT detail',
          iconName: 'cloud',
          credential: {
            titleKey: 'API key',
            promptTitleKey: 'Connect',
            promptBodyKey: 'Paste key',
          },
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Speech model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    await selectCredentialSource(entry, sourceSelection);
    const spec = createBundledLocalSttProviderSpec(entry);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: providerId, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(providerId, { model: 'speech-1' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findByType(VoiceCredentialSourceField).props)
      .toMatchObject({
        contribution: { pluginId: 'acme.speech', localId: 'multi-source-stt' },
        credentials: { slot: { id: 'api_key', purpose: 'voice.speech.transcribe' } },
    });
    await waitForTestEvent(rendered.tree.subscribe,
      () => rendered.tree.root.findByType(CredentialComponent).props.credentialSourcePurpose,
      purpose => purpose === expectedPurpose);
    expect(rendered.tree.root.findByType(CredentialComponent).props.credentialSourcePurpose).toBe(expectedPurpose);
  });

  it('renders only the canonical source selector for Connected Account-only speech', async () => {
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const declaration = parseSpeechDeclaration({
      id: 'connected-stt',
      title: 'Connected STT',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'Connected account' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'connectedAccount',
          service: { pluginId: 'acme.speech', localId: 'account' },
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['SPEECH_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 1,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 64 },
          default: 'speech-1',
          presentation: { control: 'text' },
        }],
      },
    });
    const providerId = 'acme.speech/connected-stt';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'acme.speech', providerId, declaration }],
      bundledPresentations: [{
        providerId,
        settingsSectionId: 'voice.stt.acme-connected',
        createSettingsSpec: () => ({
          titleKey: 'Connected STT',
          subtitleKey: 'Connected STT subtitle',
          detailKey: 'Connected STT detail',
          iconName: 'cloud',
          credential: {
            titleKey: 'API key',
            promptTitleKey: 'Connect',
            promptBodyKey: 'Paste key',
          },
          fields: [{
            fieldId: 'model',
            titleKey: 'Model',
            subtitleKey: 'Speech model',
          }],
          test: null,
        }),
      }],
    }).get(providerId)!;
    const spec = createBundledLocalSttProviderSpec(entry);
    await selectCredentialSource(entry, connectedAccountSelection);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: providerId, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(providerId, { model: 'speech-1' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    const sourceControls = () => ({
      sourceSelectors: rendered.tree.root.findAllByType(VoiceCredentialSourceField).length,
      savedSecretEditors: rendered.tree.root.findAllByType(CredentialComponent).length,
      rawAccessReviews: rendered.tree.root.findAllByType(VoiceRawCredentialAccessReview).length,
    });
    await waitForTestEvent(rendered.tree.subscribe, sourceControls,
      controls => controls.sourceSelectors === 1 && controls.savedSecretEditors === 0 && controls.rawAccessReviews === 1);
    expect(sourceControls()).toEqual({ sourceSelectors: 1, savedSecretEditors: 0, rawAccessReviews: 1 });
  });

  it('passes the exact selected SavedSecret speech grant through the canonical credential item', async () => {
    await saveCredential(OPENAI_COMPAT_TTS_ID, 'openai-secret-a');
    await selectCredentialSource(openAiCompatTtsEntry, { kind: 'savedSecret' });
    const { createBundledLocalTtsProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalTtsProviderSpec(openAiCompatTtsEntry);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgTts: VoiceLocalTtsSchema.parse({ provider: OPENAI_COMPAT_TTS_ID }),
      setTts: vi.fn(),
      voice: voiceWithRootProviderConfig(OPENAI_COMPAT_TTS_ID, {
        baseUrl: 'https://speech.example/v1',
        insecureLocalOriginConsent: '',
        insecureLocalConsentMachineId: '',
        model: 'tts-1',
        voiceName: 'alloy',
        format: 'mp3',
      }),
      setVoice: vi.fn(),
      networkTimeoutMs: 15_000,
      popoverBoundaryRef: null,
    }));

    expect(rendered.tree.root.findByType(CredentialComponent).props)
      .toMatchObject({
        rawCredentialReviewGrants: [{
          realm: 'daemon',
          phase: 'speech',
          request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
        }],
      });
    await waitForTestEvent(rendered.tree.subscribe,
      () => rendered.tree.root.findAllByType(VoiceRawCredentialAccessReview), reviews => reviews.length === 1);
    expect(rendered.tree.root.findAllByType(VoiceRawCredentialAccessReview)).toHaveLength(1);
    const credential = rendered.tree.root.findByType(CredentialComponent);
    const reviews = rendered.tree.root.findAllByType(VoiceRawCredentialAccessReview);
    expect(reviews).toHaveLength(1);
    expect(credential.findAllByType(VoiceRawCredentialAccessReview)).toEqual(reviews);
    expect(reviews[0].props.rawGrant).toEqual({ realm: 'daemon', phase: 'speech',
      request: { kind: 'environment', keys: ['VOICE_API_KEY'] },
    });
  });

  it('refreshes the Google catalog for credential and execution-machine changes without publishing stale results', async () => {
    const firstRequest = createDeferred<CatalogRows>();
    const credentialRequest = createDeferred<CatalogRows>();
    const machineRequest = createDeferred<CatalogRows>();
    const accountRequest = createDeferred<CatalogRows>();
    const firstRequestEntered = createDeferred<void>();
    let currentRequest = firstRequest;
    fetchCatalog.mockImplementation(async () => {
      const request = currentRequest;
      firstRequestEntered.resolve();
      return await request.promise;
    });
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const voiceSettings = voiceWithRootProviderConfig(
      GOOGLE_GEMINI_STT_ID,
      { model: 'gemini-2.5-flash', language: '' },
    );
    const renderSettings = () => React.createElement(spec!.Settings, {
      cfgStt: {
        provider: GOOGLE_GEMINI_STT_ID,
        providers: {
          [GOOGLE_GEMINI_STT_ID]: {
            schemaVersion: 2,
            config: { model: 'gemini-2.5-flash', language: null },
          },
        },
      },
      setStt: vi.fn(),
      voice: voiceSettings,
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    });
    const rendered = await renderScreen(renderSettings());
    await firstRequestEntered.promise;
    expect(fetchCatalog).toHaveBeenCalled();
    const modelItems = () => rendered.tree.root.findAllByType(DropdownMenu)
      .find(row => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'))?.props.items;

    const credential = rendered.tree.root.findByType(CredentialComponent);
    currentRequest = credentialRequest;
    const onChanged = credential.props.onChanged;
    if (!onChanged) throw new Error('Credential change callback missing');
    act(() => onChanged());
    await act(async () => credentialRequest.resolve([
      { id: 'credential-model', name: 'Credential model', metadata: {} },
    ]));
    await waitForTestEvent(rendered.tree.subscribe, modelItems,
      items => items?.some((item: { id: string }) => item.id === 'credential-model') === true);
    expect(modelItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'credential-model' }),
    ]));

    currentRequest = accountRequest;
    await act(async () => await saveCredential(GOOGLE_GEMINI_STT_ID, 'account-secret-b'));
    await act(async () => accountRequest.resolve([
      { id: 'account-model', name: 'Account model', metadata: {} },
    ]));
    await waitForTestEvent(rendered.tree.subscribe, modelItems,
      items => items?.some((item: { id: string }) => item.id === 'account-model') === true);
    expect(modelItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'account-model' }),
    ]));

    currentRequest = machineRequest;
    await act(async () => {
      executionMachine.machineId = 'machine-b';
      executionMachine.machineLabel = 'Machine B';
    });
    await rendered.update(renderSettings());
    await act(async () => machineRequest.resolve([
      { id: 'machine-model', name: 'Machine model', metadata: {} },
    ]));
    await waitForTestEvent(rendered.tree.subscribe, modelItems,
      items => items?.some((item: { id: string }) => item.id === 'machine-model') === true);
    expect(modelItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'machine-model' }),
    ]));
    await act(async () => firstRequest.resolve([
      { id: 'stale-model', name: 'Stale model', metadata: {} },
    ]));
    await flushHookEffects();

    const model = rendered.tree.root.findAllByType(DropdownMenu)
      .find((row) => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'));
    expect(model?.props.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'machine-model' }),
    ]));
    for (const obsoleteId of ['stale-model', 'credential-model', 'account-model']) {
      expect(model?.props.items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: obsoleteId }),
      ]));
    }
  });

  it('keeps a failed Google catalog visible and retryable instead of presenting an empty list', async () => {
    fetchCatalog.mockRejectedValue(new Error('catalog unavailable'));
    const { createBundledLocalSttProviderSpec } = await import('./BundledSpeechSettings');
    const spec = createBundledLocalSttProviderSpec(createDefaultVoiceProviderRegistry().get(GOOGLE_GEMINI_STT_ID)!);
    const rendered = await renderScreen(React.createElement(spec!.Settings, {
      cfgStt: { provider: GOOGLE_GEMINI_STT_ID, providers: {} },
      setStt: vi.fn(),
      voice: voiceWithRootProviderConfig(GOOGLE_GEMINI_STT_ID, { model: 'gemini-2.5-flash', language: '' }),
      setVoice: vi.fn(),
      popoverBoundaryRef: null,
    }));

    const modelItems = () => rendered.tree.root.findAllByType(DropdownMenu)
      .find(row => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'))?.props.items;
    await waitForTestEvent(rendered.tree.subscribe, modelItems,
      items => items?.some((item: { id: string }) => item.id === '__retry__') === true);
    expect(modelItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '__retry__' }),
    ]));
    const model = rendered.tree.root.findAllByType(DropdownMenu)
      .find((row) => row.props.searchPlaceholder === tLoose('settingsVoice.local.googleGeminiStt.model.searchPlaceholder'));
    fetchCatalog.mockResolvedValue([{ id: 'retry-model', name: 'Retry model', metadata: {} }]);
    await act(async () => model?.props.onSelect('__retry__'));

    await waitForTestEvent(rendered.tree.subscribe, modelItems,
      items => items?.some((item: { id: string }) => item.id === 'retry-model') === true);
    expect(modelItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'retry-model' }),
    ]));
  });
});
