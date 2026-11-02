import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { createDeferred, createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import { XAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../packages/plugins/xai/src/protocol/voice/settings';
import {
  createVoiceAudioSessionCoordinator,
  type VoiceAudioSessionPlatform,
  type VoiceAudioSessionPlatformEvent,
  type VoiceAudioSessionRequest,
} from '../../../../../packages/audio-stream-native/src/voiceAudioSessionCoordinator';

import { createNativeAudioSessionLifecycleBridge } from './nativeAudioSessionLifecycleBridge';

const ORIGINAL_PLATFORM_OS = Platform.OS;

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const vendor = vi.hoisted(() => ({ startSession: vi.fn(), setAudioModeAsync: vi.fn(async () => undefined), requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })) }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'ios' } }));
const nativeAudio = createNativeVoicePcmCaptureHarness();
const configureNativeAudioSession = (() => {
  const implementation = nativeAudio.nativeModule.configureAudioSession.getMockImplementation();
  if (!implementation) throw new Error('Missing initial native configure boundary');
  return implementation;
})();
vi.mock('expo-modules-core', async original => {
  const actual = await original<typeof import('expo-modules-core')>();
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative' ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vendor.startSession } }));
vi.mock('@elevenlabs/client/internal', () => ({ setSetupStrategy: vi.fn(), createConnection: vi.fn(), setupWebRTCSession: vi.fn() }));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vendor.setAudioModeAsync, requestRecordingPermissionsAsync: vendor.requestRecordingPermissionsAsync } }));
installDisconnectedServerSocketBoundary();

// Native module discovery is process-scoped and caches an unavailable module.
// Initialize the OS boundary before importing Sync and the real Voice consumers.
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { normalizeAccountSettingsForLocalStorage } = await import('@/sync/domains/settings/accountSettingsNormalization');
const { resolveSettingsSecretsKeySet } = await import('@/sync/encryption/resolveSettingsSecretsKeySet');
const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { resetVoiceSessionRuntimeStateForTests } = await import('@/voice/session/voiceSessionStore');
const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
const { buildVoiceTranscriptHistorySessionMetadata } = await import('@/voice/persistence/voiceTranscriptHistorySession');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const { createBundledVoiceRecipientContract } = await import('@/voice/credentials/voiceRecipientContract');
const { applyAccountVoiceCredentialSourceSelection, saveAndUseAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
const { createAccountVoiceOperationService } = await import('@/voice/credentials/accountVoiceOperationService');
const { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } = await import('@/voice/registry/bundledConversationRuntimeHost');
const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
const { getExternalVoiceProviderRegistration } = await import('@/voice/registry/externalVoiceProviderRegistrations');
const { createNativeMicSession } = await import('@/voice/runtime/mic/NativeMicSession');
const { createWebSocketPcmMedia } = await import('@/voice/runtime/connection/WebSocketPcmMedia.native');
const { requestMicrophonePermission, rejectRefusedMicrophone } = await import('@/utils/platform/microphonePermissions');

function createVendorConversation() {
  let muted = false;
  let volume = 1;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    endSession: vi.fn(async (): Promise<void> => { notify(); }),
    setMicMuted: vi.fn((value: boolean) => { muted = value; notify(); }),
    setVolume: vi.fn(({ volume: value }: Readonly<{ volume: number }>) => { volume = value; notify(); }),
    sendUserMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
    getId: () => 'native-bridge-conversation',
    isMuted: () => muted,
    getVolume: () => volume,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

async function withNativeBridge(
  run: (fixture: Readonly<{
    bridge: ReturnType<typeof createNativeAudioSessionLifecycleBridge>;
    lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
    conversation: ReturnType<typeof createVendorConversation>;
    coordinator: NonNullable<ReturnType<typeof getSharedVoiceAudioSessionCoordinator>>;
    emit(event: VoiceAudioSessionPlatformEvent): void;
  }>) => Promise<void>,
  micMuted = false,
  platform: 'ios' | 'android' = 'ios',
) {
  const previousState = storage.getState();
  const previousAdapters = getVoiceAdapterRegistry().list();
  const previousLifecycle = getVoiceSessionLifecycleController();
  voiceConversationRuntimeMachine.reset();
  (Platform as unknown as { OS: string }).OS = platform;
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
  if (!entry) throw new Error('Missing generated ElevenLabs contribution');
  const conversation = createVendorConversation();
  vendor.startSession.mockReset().mockResolvedValue(conversation);
  vi.mocked(nativeAudio.nativeModule.restoreAudioSession).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
  const historyMetadata = { path: '/voice', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() };
  const historyOwner = createSessionOwnerMetadataV1({ metadata: historyMetadata });
  if (!historyOwner.ok) throw new Error('Native fixture requires supported history owner metadata');
  const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
  sessionHttp.createSessionFromPost('bridge-history', { method: 'POST', body: JSON.stringify({
    tag: 'system:voice-transcript-history:v1', metadataLayoutVersion: 1,
    sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata: historyMetadata, agentState: null })) },
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(historyOwner.ownerMetadata),
    agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
  }) });
  const account = await restoreServerAccountForTest({
    serverUrl: 'https://native-bridge.example.test', credentialScope: 'restored-home', activation: 'switch',
    request: createSessionReadBatchFetchBoundary(async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/sessions' && init?.method === 'POST') {
        return sessionHttp.createSessionFromPost('bridge-history', init);
      }
      const sessionResponse = sessionHttp.handle(url, init);
      if (sessionResponse) return sessionResponse;
      if (new URL(String(url)).pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
      const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
      if (preparation) return preparation;
      const path = new URL(String(url)).pathname;
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'bridge-hosted-token', leaseId: 'bridge-lease', bindingNonce: 'bridge-nonce', expiresAtMs: Date.now() + 60_000 });
      if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
      return new Response('{}', { status: 404 });
    }),
  });
  const voice = writeVoiceProviderSettingsConfig(previousState.settings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
    voice: { ...voice, providerId: entry.providerId },
  }, storage.getState().settings));
  storage.setState({ sessions: {
    ...previousState.sessions, 'bridge-history': createSessionFixture({ id: 'bridge-history', serverId: account.home.id, encryptionMode: 'plain', active: false, metadata: { path: '/voice', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } }),
  } });
  const history = await sync.ensureSessionVisibleForMessageRoute('bridge-history', { forceRefresh: true, serverId: account.home.id });
  if (history.kind !== 'available') throw new Error('Native fixture history must hydrate through its Home');
  const assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
  registerVoiceAdapters(assembly.adapters);
  voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'bridge-history', conversationSessionAddress: { serverId: account.home.id, sessionId: 'bridge-history' }, targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
  const lifecycle = createVoiceSessionLifecycleController();
  setVoiceSessionLifecycleController(lifecycle);
  lifecycle.setConfiguredProviderId(entry.providerId);
  const coordinator = getSharedVoiceAudioSessionCoordinator();
  if (!coordinator) throw new Error('Missing canonical native coordinator');
  const bridge = createNativeAudioSessionLifecycleBridge({ coordinator, controller: lifecycle });
  try {
    await lifecycle.toggle(null);
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, configuration: { capture: 'provider_managed_exclusive' } });
    if (micMuted) await lifecycle.setMuted(VOICE_AGENT_GLOBAL_SESSION_ID, true);
    conversation.setMicMuted.mockClear();
    conversation.setVolume.mockClear();
    await run({ bridge, lifecycle, conversation, coordinator,
      emit: event => nativeAudio.emitEvent('voiceAudioSessionEvent', { ...event, generation: coordinator.getSnapshot().generation }),
    });
  } finally {
    bridge.dispose();
    vi.mocked(nativeAudio.nativeModule.restoreAudioSession).mockResolvedValue(undefined);
    await lifecycle.dispose();
    setVoiceSessionLifecycleController(previousLifecycle);
    await assembly.dispose();
    await resetVoiceSessionRuntimeStateForTests();
    voiceConversationRuntimeMachine.reset();
    registerVoiceAdapters(previousAdapters);
    await account.dispose();
    storage.setState(previousState, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

// Give ignored/no-op platform events a host task to expose an unwanted effect;
// positive SDK and lifecycle phases below wait for their actual publications.
const settleBridge = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function hasOutputFocus(controller: ReturnType<typeof createVoiceSessionLifecycleController>):
  controller is ReturnType<typeof createVoiceSessionLifecycleController> & {
    setOutputFocusState: NonNullable<ReturnType<typeof createVoiceSessionLifecycleController>['setOutputFocusState']>;
  } {
  return typeof controller.setOutputFocusState === 'function';
}

// The xAI native contribution is the real host-PCM consumer. Selecting Metro's
// native media owner here avoids substituting the browser PCM owner in Node.
async function withNativePcmBridge(run: (fixture: Readonly<{
  lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
  coordinator: NonNullable<ReturnType<typeof getSharedVoiceAudioSessionCoordinator>>;
  emit(event: VoiceAudioSessionPlatformEvent): void;
}>) => Promise<void>) {
  const previousState = storage.getState();
  const previousAdapters = getVoiceAdapterRegistry().list();
  const previousLifecycle = getVoiceSessionLifecycleController();
  const configure = vi.mocked(nativeAudio.nativeModule.configureAudioSession);
  configure.mockImplementation(configureNativeAudioSession);
  vi.mocked(nativeAudio.nativeModule.stop).mockClear();
  vi.mocked(nativeAudio.nativeModule.stopPlayback).mockClear();
  voiceConversationRuntimeMachine.reset();
  (Platform as unknown as { OS: string }).OS = 'ios';
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.xai');
  if (!entry) throw new Error('Missing generated xAI contribution');
  const recipientContract = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
  if (!recipientContract) throw new Error('Missing generated xAI recipient contract');
  const purposes = createConnectedPurposeCatalogHttpBoundary();
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
  // The testkit owns Socket.IO and WebRTC; neither supplies React Native's
  // WebSocket constructor with its third authentication-header argument.
  // This local boundary replaces only that vendor/OS transport.
  class NativeWebSocketBoundary extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    constructor(_url: string, _protocols?: string | string[], _options?: unknown) {
      super();
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(_data: string) {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  vi.stubGlobal('WebSocket', NativeWebSocketBoundary);
  const account = await restoreServerAccountForTest({
    serverUrl: 'https://native-bridge-pcm.example.test', credentialScope: 'restored-home', activation: 'switch',
    request: async (url, init) => new URL(String(url)).pathname === '/v1/account/profile'
      ? Response.json(AccountProfileSchema.parse({ id: 'account-a' }))
      : await purposes.handle(url, init)
      ?? answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings)
      ?? (new URL(String(url)).pathname === '/health' ? Response.json({ status: 'ok' }) : new Response('{}', { status: 404 })),
  });
  const voice = writeVoiceProviderSettingsConfig(previousState.settings.voice, entry.providerId, { ...XAI_REALTIME_DEFAULT_SETTINGS, resumptionEnabled: false });
  const contribution = { pluginId: entry.pluginId, localId: entry.declaration.id };
  const saved = saveAndUseAccountVoiceCredential({ settings: settingsParse({
    ...previousState.settings,
    ...normalizeVoiceSettingsLocalDelta({ voice: { ...voice, providerId: entry.providerId } }, previousState.settings),
  }),
    contribution, credentialSlotId: recipientContract.credentialSlot.id, expectedSettingsVersion: 1, currentDeclaration: entry.declaration,
    value: 'xai_native_bridge', generateId: () => 'native-bridge-secret', now: 1, expectedSecretId: null, expectedSecretUpdatedAt: null,
    approvedRecipientContractDigest: createRecipientContractDigestV1(recipientContract),
  });
  const selected = applyAccountVoiceCredentialSourceSelection({ settings: saved.settings, connectedPurposes: purposes.value, currentDeclaration: entry.declaration,
    mutation: { contribution, credentialSlotId: recipientContract.credentialSlot.id, expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } },
  });
  purposes.replace(selected.connectedPurposes);
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('Native PCM fixture requires its admitted Account settings scope');
  const secretKeys = await resolveSettingsSecretsKeySet({ credentials: account.credentials, scope: settingsScope });
  if (!secretKeys) throw new Error('Native PCM fixture requires device-local secret custody');
  storage.getState().applySettingsLocal(normalizeAccountSettingsForLocalStorage({
    raw: selected.accountSettings,
    mode: 'plain',
    settingsSecretsKey: secretKeys.writeKey,
    settingsSecretsReadKeys: secretKeys.readKeys,
    localSettings: storage.getState().settings,
  }));
  storage.setState({ sessions: { ...previousState.sessions,
    'bridge-pcm-history': createSessionFixture({ id: 'bridge-pcm-history', serverId: account.home.id, encryptionMode: 'plain', active: false, metadata: { path: '/voice', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } }),
  } });
  await purposes.hydrate({ serverId: account.home.id, accountId: 'account-a' });
  const providerFetch = async (url: URL | RequestInfo) => {
    if (String(url).endsWith('/v1/realtime/client_secrets')) return Response.json({ value: 'native-bridge-client-secret', expires_at: Math.floor(Date.now() / 1000) + 60 });
    throw new Error(`Unexpected provider request: ${String(url)}`);
  };
  const hostLease = createBundledConversationRuntimeHostLease();
  const host = Object.freeze({ ...hostLease.host,
    createWebSocketPcmMedia,
    createMicSession: (options: Parameters<typeof createNativeMicSession>[0]) => createNativeMicSession({ ...options,
      ensurePermission: async () => rejectRefusedMicrophone(await requestMicrophonePermission(), () => {}),
    }),
  });
  const scope = createExternalVoiceProviderActivationScope({ pluginId: entry.pluginId, occurrenceId: 'xai-native-bridge-occurrence', declarations: [entry.declaration], hostPlatform: 'ios',
    runtimeHost: host, isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
    hostBindingsByLocalId: { [entry.declaration.id]: { recipientContract, descriptor: 'bundled',
      createInvocationAccountOperations: (signal, _conversationSessionId, isCurrent, phase) => createAccountVoiceOperationService({
        providerId: entry.providerId, contribution, declaration: entry.declaration, phase, recipientContract, signal, isCurrent, fetch: providerFetch,
      }),
    } },
  });
  const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
  (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
  await scope.commit();
  const adapter = getExternalVoiceProviderRegistration(entry.providerId)?.adapter;
  if (!adapter) throw new Error('Generated native xAI entry was not activated');
  registerVoiceAdapters([adapter]);
  voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'bridge-pcm-history', conversationSessionAddress: { serverId: account.home.id, sessionId: 'bridge-pcm-history' }, targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
  const lifecycle = createVoiceSessionLifecycleController();
  setVoiceSessionLifecycleController(lifecycle);
  lifecycle.setConfiguredProviderId(entry.providerId);
  const coordinator = getSharedVoiceAudioSessionCoordinator();
  if (!coordinator) throw new Error('Missing canonical native PCM coordinator');
  const bridge = createNativeAudioSessionLifecycleBridge({ coordinator, controller: lifecycle });
  try {
    await lifecycle.toggle(null);
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(coordinator.getSnapshot()).toMatchObject({ configuration: { input: true, output: true, aec: 'required', capture: 'host_managed' }, capabilities: { aecActive: true } });
    await run({ lifecycle, coordinator, emit: event => nativeAudio.emitEvent('voiceAudioSessionEvent', event) });
  } finally {
    bridge.dispose();
    configure.mockImplementation(configureNativeAudioSession);
    await lifecycle.dispose();
    setVoiceSessionLifecycleController(previousLifecycle);
    await scope.unwind();
    hostLease.revoke();
    await resetVoiceSessionRuntimeStateForTests();
    voiceConversationRuntimeMachine.reset();
    registerVoiceAdapters(previousAdapters);
    await account.dispose();
    storage.setState(previousState, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  (Platform as unknown as { OS: string }).OS = ORIGINAL_PLATFORM_OS;
});

// F: a currently active generated native Voice contribution always retains an
// output request (PCM conversation policy or provider-exclusive call mode).
// This unique input-only reconfiguration port contract stays until a real
// input-only Voice consumer can produce it; it is not composed runtime proof.
function createReconfigurationHarness() {
  const muteListeners = new Set<() => void>();
  let platformListener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  const platform: VoiceAudioSessionPlatform = {
    apply: vi.fn(async ({ generation, configuration }) => {
      platformListener?.({
        generation,
        kind: 'focus_changed',
        state: configuration.output ? 'gained' : 'not_required',
      });
      return {
        generation,
        aecAvailable: true,
        aecActive: false,
        route: 'speaker',
      };
    }),
    restore: vi.fn(async () => undefined),
    subscribe: (listener) => {
      platformListener = listener;
      return { remove: () => { platformListener = null; } };
    },
  };
  const coordinator = createVoiceAudioSessionCoordinator({ platform });
  const snapshot = {
    adapterId: 'local_conversation', sessionId: 'voice-global', status: 'connected' as const,
    mode: 'listening' as const, canStop: true, micMuted: false,
  };
  const controller = {
    getSnapshot: vi.fn(() => snapshot),
    setOutputFocusState: vi.fn(async (): Promise<'applied' | 'unsupported'> => 'applied'),
    setMuted: vi.fn(async (_sessionId: string, _muted: boolean) => { for (const listener of muteListeners) listener(); }),
    suspendInput: vi.fn(async () => {
      await controller.setMuted('voice-global', true);
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await controller.setMuted('voice-global', false);
        },
      };
    }),
    stop: vi.fn(async () => undefined),
  };
  const bridge = createNativeAudioSessionLifecycleBridge({ coordinator, controller });
  const request = (overrides: Partial<VoiceAudioSessionRequest> = {}): VoiceAudioSessionRequest => ({
    ownerId: 'capture',
    mode: 'conversation',
    input: true,
    output: true,
    aec: 'preferred',
    capture: 'host_managed',
    ...overrides,
  });
  return {
    bridge,
    controller,
    coordinator,
    emit: (event: VoiceAudioSessionPlatformEvent) => platformListener?.(event),
    request,
    subscribeMute: (listener: () => void) => { muteListeners.add(listener); return () => { muteListeners.delete(listener); }; },
  };
}

describe('createNativeAudioSessionLifecycleBridge', () => {
  it('auto-mutes across overlapping transient suspension reasons and resumes only after all clear', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'interruption_began' });
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);
    await waitForTestEvent(conversation.subscribe, conversation.getVolume, volume => volume === 0);
    expect(conversation.getVolume()).toBe(0);
    emit({ generation: 1, kind: 'interruption_ended', shouldResume: true });
    await settleBridge();
    expect(conversation.isMuted()).toBe(true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => !muted);
    expect(conversation.isMuted()).toBe(false);
    expect(conversation.getVolume()).toBe(1);
    });
  });

  it('removes only its interruption suspension when the user mutes during the interruption', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'interruption_began' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);
    await lifecycle.setMuted(VOICE_AGENT_GLOBAL_SESSION_ID, true);
    emit({ generation: 1, kind: 'interruption_ended', shouldResume: true });
    await settleBridge();
    expect(conversation.setMicMuted).not.toHaveBeenCalledWith(false);
    expect(conversation.isMuted()).toBe(true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    });
  });

  it('does not unmute a Voice attempt that was already user-muted before interruption', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'interruption_began' });
    emit({ generation: 1, kind: 'interruption_ended', shouldResume: true });
    await settleBridge();
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    expect(conversation.isMuted()).toBe(true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    }, true);
  });

  it('releases an acquired suspension lease when the bridge is disposed', async () => {
    await withNativeBridge(async ({ bridge, conversation, emit }) => {
    emit({ generation: 1, kind: 'interruption_began' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);
    bridge.dispose();
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => !muted);
    expect(conversation.isMuted()).toBe(false);
    });
  });

  it('releases a suspension lease that materializes after disposal', async () => {
    await withNativeBridge(async ({ bridge, lifecycle, conversation, emit }) => {
      const setPhysicalMute = conversation.setMicMuted.getMockImplementation();
      if (!setPhysicalMute) throw new Error('Missing SDK mute boundary');
      // Dispose inside the synchronous SDK write, before the real lifecycle's
      // async mute settlement can return its suspension lease to the bridge.
      conversation.setMicMuted.mockImplementation(muted => {
        setPhysicalMute(muted);
        if (muted) bridge.dispose();
      });
      emit({ generation: 1, kind: 'interruption_began' });
      await waitForTestEvent(conversation.subscribe, () => conversation.setMicMuted.mock.calls, calls => calls.length === 2);
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.micMuted !== true);
      expect(lifecycle.getSnapshot().micMuted === true).toBe(false);
      expect(conversation.setMicMuted.mock.calls).toEqual([[true], [false]]);
      expect(conversation.isMuted()).toBe(false);
      expect(lifecycle.getSnapshot().micMuted === true).toBe(false);
    });
  });

  it('keeps an active unmuted iOS Voice attempt unchanged through ordinary background and foreground transitions', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await settleBridge();
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(conversation.isMuted()).toBe(false);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    expect(conversation.setVolume).not.toHaveBeenCalled();
    expect(conversation.endSession).not.toHaveBeenCalled();
    });
  });

  it('preserves an explicit iOS Voice mute through ordinary background and foreground transitions', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await settleBridge();
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
    expect(conversation.isMuted()).toBe(true);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    expect(conversation.setVolume).not.toHaveBeenCalled();
    expect(conversation.endSession).not.toHaveBeenCalled();
    }, true);
  });

  it('keeps an active unmuted Android Voice attempt unchanged through ordinary background and foreground transitions', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });

    await settleBridge();
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(conversation.isMuted()).toBe(false);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    expect(conversation.setVolume).not.toHaveBeenCalled();
    expect(conversation.endSession).not.toHaveBeenCalled();
    }, false, 'android');
  });

  it('does not let a duckable focus signal clear a true transient capture suspension', async () => {
    await withNativeBridge(async ({ conversation, emit }) => {
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);

    // This platform fact is intentionally distinct from transient loss. The
    // native output owner can apply its own duck policy, while capture stays
    // suspended until Android reports focus gain.
    emit({ generation: 1, kind: 'focus_duckable' });
    await settleBridge();
    expect(conversation.isMuted()).toBe(true);
    expect(conversation.getVolume()).toBe(0);

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => !muted);
    expect(conversation.isMuted()).toBe(false);
    });
  });

  it('suspends provider-neutral output for transient focus loss and restores only on gain', async () => {
    await withNativeBridge(async ({ conversation, emit }) => {
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(conversation.subscribe, conversation.getVolume, volume => volume === 0);
    expect(conversation.getVolume()).toBe(0);
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);

    // A duckable notification after a real transient loss must not downgrade
    // the output suspension before Android has returned focus.
    emit({ generation: 1, kind: 'focus_duckable' });
    await settleBridge();
    expect(conversation.getVolume()).toBe(0);

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await waitForTestEvent(conversation.subscribe, conversation.getVolume, volume => volume === 1);
    expect(conversation.getVolume()).toBe(1);
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => !muted);
    expect(conversation.isMuted()).toBe(false);
    });
  });

  it('ducks output without muting capture and restores it on focus gain', async () => {
    await withNativeBridge(async ({ conversation, emit }) => {
    emit({ generation: 1, kind: 'focus_duckable' });
    await waitForTestEvent(conversation.subscribe, conversation.getVolume, volume => volume === 0.18);
    expect(conversation.getVolume()).toBe(0.18);
    expect(conversation.isMuted()).toBe(false);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();

    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });
    await waitForTestEvent(conversation.subscribe, conversation.getVolume, volume => volume === 1);
    expect(conversation.getVolume()).toBe(1);
    });
  });

  it('does not mute capture when the lifecycle owner reports output suspension unsupported', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    conversation.setVolume.mockImplementation(() => { throw new TypeError('Vendor output volume is unsupported'); });
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });

    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
    // Exact-adapter fail-closed settlement belongs to the lifecycle controller;
    // this bridge must not re-resolve and stop a same-id replacement.
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    });
  });

  it('does not unmute when active output restoration is unsupported', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);
    conversation.setVolume.mockImplementation(() => { throw new TypeError('Vendor output restoration is unsupported'); });
    emit({ generation: 1, kind: 'focus_changed', state: 'gained' });

    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
    expect(lifecycle.getSnapshot().status).toBe('disconnected');
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    expect(conversation.setMicMuted).not.toHaveBeenCalledWith(false);
    });
  });

  it('does not unmute when active output restoration throws', async () => {
    // F: the current lifecycle normalizes adapter and Stop errors to
    // 'unsupported'. Retain its rejected-Promise port contract independently;
    // throwing at SDK setVolume exercises unsupported, not this catch branch.
    let listener: (event: VoiceAudioSessionPlatformEvent) => void = () => {};
    const released = createDeferred<void>();
    const suspended = createDeferred<void>();
    const restored = createDeferred<void>();
    const release = vi.fn(async () => { released.resolve(); });
    const suspendInput = vi.fn(async () => { suspended.resolve(); return { release }; });
    const stop = vi.fn(async () => undefined);
    const focus = vi.fn(async (): Promise<'applied' | 'unsupported'> => 'applied')
      .mockResolvedValueOnce('applied').mockImplementationOnce(async () => { restored.resolve(); throw new Error('output_restore_failed'); });
    const bridge = createNativeAudioSessionLifecycleBridge({
      coordinator: {
        subscribe(next: (event: VoiceAudioSessionPlatformEvent) => void) { listener = next; return { remove() {} }; },
        getSnapshot: () => ({ configuration: { aec: 'preferred' as const } }),
      } as never,
      controller: { getSnapshot: () => ({ sessionId: 'voice-global', status: 'connected' as const }), suspendInput, setOutputFocusState: focus, stop },
    });
    try {
      listener({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
      await suspended.promise;
      expect(suspendInput).toHaveBeenCalledTimes(1);
      listener({ generation: 1, kind: 'focus_changed', state: 'gained' });
      await restored.promise;
      expect(focus).toHaveBeenCalledTimes(2);
      await settleBridge();
      expect(release).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
      await released.promise;
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it('does not stop a same-session replacement after delayed output focus failure', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
      const ending = createDeferred<void>();
      const endEntered = createDeferred<void>();
      const restoreEntered = createDeferred<void>();
      const restore = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
      const restoreAudio = restore.getMockImplementation();
      if (!restoreAudio) throw new Error('Missing native restore boundary');
      restore.mockImplementationOnce(async () => { restoreEntered.resolve(); await restoreAudio(); });
      conversation.endSession.mockImplementationOnce(async () => { endEntered.resolve(); await ending.promise; });
      conversation.setVolume.mockImplementationOnce(() => {
        throw new TypeError('Vendor output focus is unavailable');
      });
      if (!hasOutputFocus(lifecycle)) throw new Error('Expected lifecycle output focus');
      const focusObserver = vi.spyOn(lifecycle, 'setOutputFocusState');
      emit({ generation: 1, kind: 'focus_changed', state: 'lost_transient' });
      await endEntered.promise;
      expect(conversation.endSession).toHaveBeenCalledTimes(1);
      const focusResult = focusObserver.mock.results[0];
      if (focusResult?.type !== 'return') throw new Error('Expected the actual lifecycle focus work');
      let focusSettled = false;
      const focusWork = focusResult.value.then(result => {
        focusSettled = true;
        return result;
      });
      await restoreEntered.promise;
      expect(coordinator.getSnapshot().leaseCount).toBe(0);
      const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
      if (!entry) throw new Error('Missing generated ElevenLabs contribution');
      const replacement = createVendorConversation();
      vendor.startSession.mockResolvedValueOnce(replacement);
      const replacementAssembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
      const replacementAdapter = replacementAssembly.adapters.find(adapter => adapter.id === entry.providerId);
      if (!replacementAdapter) throw new Error('Missing generated replacement adapter');
      try {
        registerVoiceAdapters(replacementAssembly.adapters);
        await replacementAdapter.start({
          sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
          requestedTargetSessionAddress: null,
          textOnly: true,
        });
        expect(replacementAdapter.getSnapshot()).toMatchObject({
          sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected',
        });
        expect(vendor.startSession.mock.calls.at(-1)?.[0]).toMatchObject({
          textOnly: true, overrides: { conversation: { textOnly: true } },
        });
        expect(coordinator.getSnapshot().leaseCount).toBe(1);
        expect(focusSettled).toBe(false);
        await replacementAdapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
        expect(replacement.isMuted()).toBe(true);
        ending.resolve();
        await expect(focusWork).resolves.toBe('unsupported');
        expect(replacementAdapter.getSnapshot().status).toBe('connected');
        expect(replacement.isMuted()).toBe(true);
        expect(replacement.endSession).not.toHaveBeenCalled();
      } finally {
        ending.resolve();
        await focusWork;
        await replacementAssembly.dispose();
      }
    });
  });

  it('clears a transient capture suspension only from the replacement focus generation', async () => {
    await withNativePcmBridge(async ({ lifecycle, coordinator, emit }) => {
    const firstGeneration = coordinator.getSnapshot().generation;
    emit({ generation: firstGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.micMuted === true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    const configure = vi.mocked(nativeAudio.nativeModule.configureAudioSession);
    configure.mockImplementation(async request => {
      const result = await configureNativeAudioSession(request);
      emit({ generation: request.generation, kind: 'focus_changed', state: request.configuration.output ? 'gained' : 'not_required' });
      return result;
    });
    const replacement = await coordinator.acquire({ ownerId: 'replacement-playback', mode: 'playback', input: false, output: true, aec: 'off', capture: 'host_managed' });
    const replacementGeneration = coordinator.getSnapshot().generation;
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.micMuted !== true);
    expect(lifecycle.getSnapshot().micMuted === true).toBe(false);

    emit({ generation: replacementGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.micMuted === true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    emit({ generation: firstGeneration, kind: 'focus_changed', state: 'gained' });
    await settleBridge();
    expect(lifecycle.getSnapshot().micMuted).toBe(true);

    emit({ generation: replacementGeneration, kind: 'focus_changed', state: 'gained' });
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.micMuted !== true);
    expect(lifecycle.getSnapshot().micMuted === true).toBe(false);

    await replacement.release();
    configure.mockImplementation(configureNativeAudioSession);
    });
  });

  it('clears a focus suspension when the replacement configuration no longer needs output focus', async () => {
    const { bridge, controller, coordinator, emit, request, subscribeMute } = createReconfigurationHarness();
    const input = await coordinator.acquire(request({ output: false }));
    const output = await coordinator.acquire(request({ ownerId: 'output' }));
    const outputGeneration = coordinator.getSnapshot().generation;
    emit({ generation: outputGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await waitForTestEvent(subscribeMute, () => controller.setMuted.mock.calls.at(-1)?.[1], muted => muted === true);
    expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', true);

    await output.release();
    const inputOnlyGeneration = coordinator.getSnapshot().generation;
    await waitForTestEvent(subscribeMute, () => controller.setMuted.mock.calls.at(-1)?.[1], muted => muted === false);
    expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false);

    emit({ generation: outputGeneration, kind: 'focus_changed', state: 'lost_transient' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.setMuted).toHaveBeenLastCalledWith('voice-global', false);
    expect(inputOnlyGeneration).not.toBe(outputGeneration);

    await input.release();
    bridge.dispose();
  });

  it('never unmutes a session that was already user-muted', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, emit }) => {
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'background' });
    emit({ generation: 1, kind: 'lifecycle_changed', state: 'foreground' });
    await settleBridge();
    expect(conversation.isMuted()).toBe(true);
    expect(lifecycle.getSnapshot().micMuted).toBe(true);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    }, true, 'android');
  });

  it('stops fail-closed when interruption cannot resume or focus is permanently lost', async () => {
    await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
      emit({ generation: 1, kind: 'interruption_began' });
      emit({ generation: 1, kind: 'interruption_ended', shouldResume: false });
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
      expect(lifecycle.getSnapshot().status).toBe('disconnected');
      expect(conversation.endSession).toHaveBeenCalledTimes(1);
      expect(coordinator.getSnapshot().leaseCount).toBe(0);
    });
    await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
      emit({ generation: 2, kind: 'focus_changed', state: 'lost_permanent' });
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
      expect(lifecycle.getSnapshot().status).toBe('disconnected');
      expect(conversation.endSession).toHaveBeenCalledTimes(1);
      expect(coordinator.getSnapshot().leaseCount).toBe(0);
    });
  });

  it.each(['ios', 'android'] as const)('releases suspension custody and retries failed native Stop on %s', async platform => {
    await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
    // The vendor End boundary is best-effort by contract. Native lease release
    // is the fallible teardown boundary that reaches the real lifecycle Stop.
    const restore = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
    restore.mockRejectedValue(new Error('session_stop_failed'));
    const suspensionReleased = createDeferred<void>();
    const suspendInput = lifecycle.suspendInput.bind(lifecycle);
    const suspension = vi.spyOn(lifecycle, 'suspendInput').mockImplementation(async (...args) => {
      const lease = await suspendInput(...args);
      return lease ? { async release() {
        try { await lease.release(); } finally { suspensionReleased.resolve(); }
      } } : null;
    });
    const stopped = createDeferred<void>();
    const stop = lifecycle.stop.bind(lifecycle);
    vi.spyOn(lifecycle, 'stop').mockImplementation(async (...args) => {
      try { await stop(...args); } finally { stopped.resolve(); }
    });
    emit({ generation: 1, kind: 'interruption_began' });
    await waitForTestEvent(conversation.subscribe, conversation.isMuted, muted => muted);
    expect(conversation.isMuted()).toBe(true);

    const admission = suspension.mock.results.at(-1);
    if (admission?.type !== 'return') throw new Error('The real native suspension was not admitted');
    await admission.value;

    emit({ generation: 1, kind: 'interruption_ended', shouldResume: false });

    await stopped.promise;
    await suspensionReleased.promise;
    // R27 retains Stop until the adapter's physical cleanup succeeds. Releasing
    // the bridge suspension must neither hide that custody nor reopen input.
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle', canStop: true });
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, pendingReleaseCount: 1 });
    await expect(lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID)).rejects.toThrow('session_stop_failed');
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle', canStop: true });
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, pendingReleaseCount: 1 });

    restore.mockResolvedValue(undefined);
    // Recover through the same user-facing End, without acquiring an unrelated
    // lease to trigger coordinator recovery on the user's behalf.
    await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, pendingReleaseCount: 0 });
    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    }, false, platform);
  });

  it('stops when required echo cancellation is lost at runtime', async () => {
    await withNativePcmBridge(async ({ lifecycle, coordinator, emit }) => {
      emit({ generation: coordinator.getSnapshot().generation, kind: 'capabilities_changed', aecAvailable: true, aecActive: false });
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
      expect(lifecycle.getSnapshot().status).toBe('disconnected');
      expect(coordinator.getSnapshot().leaseCount).toBe(0);
      expect(nativeAudio.nativeModule.stop).toHaveBeenCalled();
      expect(nativeAudio.nativeModule.stopPlayback).toHaveBeenCalled();
    });
  });

  it('stops the session when the native audio graph reports itself terminal', async () => {
    // A media-services reset or an unrecoverable engine configuration change
    // leaves the native graph dead while the session still looks connected.
    // Nothing else observes that, so the lifecycle owner has to end the session.
    for (const reason of ['media_services_reset', 'configuration_unrecoverable'] as const) {
      await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
        emit({ generation: 1, kind: 'audio_graph_terminal', reason });
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'disconnected');
        expect(lifecycle.getSnapshot().status).toBe('disconnected');
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        expect(coordinator.getSnapshot().leaseCount).toBe(0);
      });
    }
  });

  it('leaves an ordinary route change to the native owner instead of ending the session', async () => {
    // Route changes are constant and survivable; the native owner is the only
    // party that can tell a survivable one from a dead graph, and it says so
    // with `audio_graph_terminal`.
    await withNativeBridge(async ({ lifecycle, conversation, coordinator, emit }) => {
    emit({ generation: 1, kind: 'route_changed', route: 'BluetoothHFP' });
    await settleBridge();
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(coordinator.getSnapshot().capabilities?.route).toBe('BluetoothHFP');
    expect(conversation.endSession).not.toHaveBeenCalled();
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    });
  });

  it('removes the native listener and makes queued work inert on disposal', async () => {
    await withNativeBridge(async ({ bridge, lifecycle, conversation, emit }) => {
    // Queue one event before disposal, then deliver another after subscription
    // removal: neither may mutate the still-connected physical SDK capture.
    emit({ generation: 1, kind: 'interruption_began' });
    bridge.dispose();
    emit({ generation: 1, kind: 'interruption_began' });
    await settleBridge();
    expect(lifecycle.getSnapshot().status).toBe('connected');
    expect(conversation.isMuted()).toBe(false);
    expect(conversation.setMicMuted).not.toHaveBeenCalled();
    });
  });
});
