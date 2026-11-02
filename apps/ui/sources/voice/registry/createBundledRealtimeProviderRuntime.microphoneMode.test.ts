import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storage';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createBuiltinVoiceAdapterAssembly } from '@/dev/testkit/harness/builtinVoiceAdapters';
import { getVoiceAdapterRegistry, registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionRuntimeStateForTests } from '@/voice/session/voiceSessionStore';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from './generatedBundledVoiceRuntimeEntries';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import { getSharedVoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';
import type { RealtimeVoiceProviderRuntime } from '@happier-dev/plugin-sdk/voice/client';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from './bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import { createWebSocketPcmMedia as createNativeWebSocketPcmMedia } from '@/voice/runtime/connection/WebSocketPcmMedia.native';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const vendor = vi.hoisted(() => ({ platform: 'web' as 'web' | 'ios', startSession: vi.fn(), setAudioModeAsync: vi.fn(async (_mode: unknown) => {}), requestRecordingPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })) }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { get OS() { return vendor.platform; } } }));
// Native discovery is process-owned and may run during the first static import.
const nativeAudio = await vi.hoisted(async () => {
  const { createNativeVoicePcmCaptureHarness } = await import('@/dev/testkit/harness/nativeVoicePcmCapture');
  return createNativeVoicePcmCaptureHarness();
});
vi.mock('expo-modules-core', async original => {
  const actual = await original<typeof import('expo-modules-core')>();
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'HappierAudioStreamNative' ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});
// The vendor owns its microphone. The generated entry, activation, codecs,
// runtime host, controller, lifecycle and projection below all remain real.
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vendor.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: vendor.startSession } }));
vi.mock('@elevenlabs/client/internal', () => ({ setSetupStrategy: vi.fn(), createConnection: vi.fn(), setupWebRTCSession: vi.fn() }));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vendor.setAudioModeAsync, requestRecordingPermissionsAsync: vendor.requestRecordingPermissionsAsync } }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

type MicrophoneMode = 'host_webrtc' | 'host_pcm' | 'provider_managed';

/** Authored external provider: only its SDK mute/connection boundary is controlled. */
async function createRuntimeForMode(
  mode: MicrophoneMode,
  input?: Readonly<{ setInputMuted?: (muted: boolean) => Promise<void> | void }>,
) {
  const platform = mode === 'host_pcm' ? 'ios' : 'web';
  vendor.platform = platform;
  vendor.setAudioModeAsync.mockClear();
  vendor.requestRecordingPermissionsAsync.mockClear();
  const environment = await createOpenAiVoiceRuntimeEnvironment();
  const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer(peer) {
    peer.setRemoteDescription.mockImplementation(async () => {
      peer.channel.open();
      peer.connectionState = 'connected';
      peer.dispatchEvent(new Event('connectionstatechange'));
    });
  } });
  const hostLease = createBundledConversationRuntimeHostLease();
  const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
    id: 'microphone', title: 'Public microphone authority', kind: 'conversation',
    roles: ['realtime_conversation'], platforms: [platform],
    capabilities: { turn: { cancelResponse: false, bargeIn: false, interruptionPolicy: 'disabled' } },
    client: { artifactId: 'microphone-client', exportName: 'activate' },
  }] }).voiceProviders[0]!;
  if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
  const pluginId = 'conformance.voice.microphone';
  const providerId = `${pluginId}/${declaration.id}`;
  const sdk = { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const setInputMuted = vi.fn(input?.setInputMuted ?? (async () => undefined));
  const microphoneConfig = mode === 'provider_managed'
    ? { microphoneMode: 'provider_managed' as const, setInputMuted }
    : { microphoneMode: mode, ...(input?.setInputMuted ? { setInputMuted } : {}) };
  const publicRuntime: RealtimeVoiceProviderRuntime = {
    kind: 'conversation', ...microphoneConfig,
    protocol: {
      async prepare({ signal }) {
        return signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } };
      },
      decodeControl: () => [], encodeTurnControl: () => null,
    },
    async createConnection({ media }) {
      if (mode === 'host_webrtc') return media.createWebRtcConnection({
        signaling: { async exchangeOffer() { await sdk.open(); return { answerSdp: 'v=0\r\na=microphone-answer\r\n' }; } },
        control: { label: 'microphone-events', onOpen: () => undefined },
      });
      if (mode === 'host_pcm') return media.createPcmConnection({
        driver: { open: sdk.open, sendControl: async () => undefined, close: sdk.close },
        input: { sampleRate: 24_000, chunkMs: 100 }, output: { sampleRate: 24_000 }, onInputChunk: () => undefined,
      }).connection;
      return media.createSdkHandleConnection({ driver: {
        open: sdk.open, sendControl: async () => undefined, close: sdk.close,
      } });
    },
    encodeToolResults: () => [], encodeToolContinuation: () => null,
    encodeContextUpdate: () => [], encodeTextTurn: () => [],
  };
  const scope = createExternalVoiceProviderActivationScope({
    pluginId, occurrenceId: 'microphone-mode-occurrence', declarations: [declaration], hostPlatform: platform,
    // Select Metro's real platform producer in the Node source runner.
    runtimeHost: platform === 'web'
      ? { ...hostLease.host, createMicSession: browser.createMicSession }
      : { ...hostLease.host, createWebSocketPcmMedia: createNativeWebSocketPcmMedia },
    isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
  });
  scope.api.voiceProviders.register(declaration.id, publicRuntime);
  await scope.commit();
  const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
  if (!adapter) throw new Error('Public microphone provider activation failed');
  registerVoiceAdapters([adapter]);
  await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
    providers: { [providerId]: { schemaVersion: 1, config: {} } } });
  voiceSessionBindingStore.getState().bind({
    adapterId: providerId, controlSessionId: hostLease.host.globalVoiceSessionId,
    conversationSessionId: environment.historySessionId,
    conversationSessionAddress: { serverId: environment.accountConnection.home.id, sessionId: environment.historySessionId },
    targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1,
  });
  return {
    adapter, browser, sdk, setInputMuted, controlSessionId: hostLease.host.globalVoiceSessionId,
    async dispose() {
      try { await scope.unwind(); }
      finally {
        hostLease.revoke();
        browser.restore();
        await environment.dispose();
        vendor.platform = 'web';
      }
    },
  };
}

describe('public provider microphone mode', () => {
  it('chooses one declared microphone authority before connection creation', async () => {
    const webRtc = await createRuntimeForMode('host_webrtc');
    try {
      await webRtc.adapter.start({ sessionId: webRtc.controlSessionId, requestedTargetSessionAddress: null });
      expect(webRtc.adapter.getSnapshot().status).toBe('connected');
      expect(webRtc.browser.micTrack.readyState).toBe('live');
      expect(vendor.setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsRecording: true }));
      expect(vendor.setAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(webRtc.sdk.open.mock.invocationCallOrder[0]!);
    } finally { await webRtc.dispose(); }

    const pcm = await createRuntimeForMode('host_pcm');
    try {
      await pcm.adapter.start({ sessionId: pcm.controlSessionId, requestedTargetSessionAddress: null });
      expect(pcm.adapter.getSnapshot().status).toBe('connected');
      expect(vendor.requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(vendor.requestRecordingPermissionsAsync.mock.invocationCallOrder[0]).toBeLessThan(pcm.sdk.open.mock.invocationCallOrder[0]!);
      expect(pcm.browser.micTracks).toHaveLength(0);
      expect(vendor.setAudioModeAsync).not.toHaveBeenCalled();
      expect(nativeAudio.nativeModule.start).toHaveBeenCalled();
    } finally { await pcm.dispose(); }
  });

  it('retires host capture when a secondary provider mute hook rejects silence', async () => {
    const webRtc = await createRuntimeForMode('host_webrtc', {
      setInputMuted: async muted => {
        if (muted) throw new Error('secondary_capture_mute_rejected');
      },
    });
    try {
      await webRtc.adapter.start({ sessionId: webRtc.controlSessionId, requestedTargetSessionAddress: null });
      const track = webRtc.browser.micTrack;
      expect(track.readyState).toBe('live');
      await expect(webRtc.adapter.setMuted({ sessionId: webRtc.controlSessionId, muted: true })).rejects.toThrow('secondary_capture_mute_rejected');
      await webRtc.browser.captures[0]!.stopped;
      expect(track.readyState).toBe('ended');
      expect(webRtc.adapter.getSnapshot().status).not.toBe('connected');
      expect(webRtc.browser.peer.connectionState).toBe('closed');
    } finally { await webRtc.dispose(); }
  });
});

async function withGeneratedElevenLabs(
  run: (fixture: Readonly<{
    lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
    adapter: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>>['adapters'][number];
    assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>>;
    getUserMedia: MockInstance<MediaDevices['getUserMedia']>;
  }>) => Promise<void>,
  platform: 'web' | 'ios' = 'web',
): Promise<void> {
  const previousState = storage.getState();
  const previousAdapters = getVoiceAdapterRegistry().list();
  const previousLifecycle = getVoiceSessionLifecycleController();
  voiceConversationRuntimeMachine.reset();
  const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.elevenlabs');
  if (!entry) throw new Error('Missing generated ElevenLabs contribution');
  vendor.setAudioModeAsync.mockReset().mockResolvedValue(undefined);
  vendor.platform = platform;
  const browser = installVoiceWebRtcBrowserBoundary();
  const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(new Error('Host must not acquire the provider microphone'));
  const environment = await createOpenAiVoiceRuntimeEnvironment();
  await environment.configureVoice({
    ...writeVoiceProviderSettingsConfig(environment.persistedAccountSettings.voice, entry.providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS),
    providerId: entry.providerId,
  });
  // Compose the hosted service's HTTP boundary with the incumbent Account
  // bootstrap. Tokens/leases remain parsed by the real hosted owner.
  setRuntimeFetch(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/voice/token') return Response.json({ allowed: true, token: 'mode-hosted-token', leaseId: 'mode-lease', bindingNonce: 'mode-nonce', expiresAtMs: Date.now() + 60_000 });
    if (path === '/v1/voice/session/complete' || path === '/v1/voice/session/release') return Response.json({ ok: true });
    if (path === '/health' || path === '/v1/auth/ping') return Response.json({ status: 'ok' });
    return await environment.homeRequest(url, init) ?? new Response('{}', { status: 404 });
  });
  // The incumbent environment restored the Account through real TokenStorage
  // and hydrated the canonical settings document through Sync.
  const account = environment.accountConnection;
  const assembly = (await createBuiltinVoiceAdapterAssembly({ bundledEntries: [entry] }));
  const adapter = assembly.adapters.find(value => value.id === entry.providerId);
  if (!adapter) throw new Error('Generated ElevenLabs entry was not activated');
  registerVoiceAdapters(assembly.adapters);
  voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: environment.historySessionId, conversationSessionAddress: { serverId: account.home.id, sessionId: environment.historySessionId }, targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
  const lifecycle = createVoiceSessionLifecycleController();
  setVoiceSessionLifecycleController(lifecycle);
  lifecycle.setConfiguredProviderId(entry.providerId);
  try {
    await run({ lifecycle, adapter, assembly, getUserMedia });
  } finally {
    await lifecycle.dispose();
    setVoiceSessionLifecycleController(previousLifecycle);
    await assembly.dispose();
    await resetVoiceSessionRuntimeStateForTests();
    voiceConversationRuntimeMachine.reset();
    await environment.dispose();
    browser.restore();
    registerVoiceAdapters(previousAdapters);
    storage.setState(previousState, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vendor.platform = 'web';
  }
}

function createVendorConversation(id = 'mode-conversation') {
  let muted = false;
  const setMicMuted = vi.fn((value: boolean) => { muted = value; });
  return {
    endSession: vi.fn(async (): Promise<void> => {}),
    setMicMuted,
    setVolume: vi.fn(),
    sendUserMessage: vi.fn(),
    sendContextualUpdate: vi.fn(),
    getId: () => id,
    isMuted: () => muted,
  };
}

describe('generated ElevenLabs provider microphone authority', () => {
  it('reports a fallible native release while the real coordinator retains cleanup and the SDK is already closed', async () => {
    const conversation = createVendorConversation();
    vendor.startSession.mockReset().mockResolvedValue(conversation);
    const restore = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
    restore.mockReset().mockRejectedValueOnce(new Error('native_restore_failed')).mockResolvedValue(undefined);
    await withGeneratedElevenLabs(async ({ lifecycle, assembly, getUserMedia }) => {
      try {
        await lifecycle.toggle(null);
        await expect(assembly.dispose()).rejects.toThrow('native_restore_failed');
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        const coordinator = getSharedVoiceAudioSessionCoordinator();
        if (!coordinator) throw new Error('Missing real native audio coordinator');
        // Reacquisition is a public recovery path: it joins the coordinator's
        // retained failed release before admitting a fresh lease.
        const next = await coordinator.acquire({ ownerId: 'mode-release-recovery', mode: 'conversation', input: true, output: true, aec: 'preferred', capture: 'provider_managed_exclusive' });
        expect(coordinator.getSnapshot().pendingReleaseCount).toBe(0);
        await next.release();
        await assembly.dispose();
        expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, pendingReleaseCount: 0, configuration: null });
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        expect(getUserMedia).not.toHaveBeenCalled();
      } finally {
        restore.mockResolvedValue(undefined);
      }
    }, 'ios');
  });

  it('keeps coalesced disposal pending behind native audio release and the vendor teardown', async () => {
    const conversation = createVendorConversation();
    let finishSdkStop!: () => void;
    const sdkStopEntered = createDeferred<void>();
    const sdkStop = new Promise<void>(resolve => { finishSdkStop = resolve; });
    conversation.endSession.mockImplementation(() => { sdkStopEntered.resolve(); return sdkStop; });
    vendor.startSession.mockReset().mockResolvedValue(conversation);
    const configure = vi.mocked(nativeAudio.nativeModule.configureAudioSession);
    const restore = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
    configure.mockClear();
    let finishNativeRestore!: () => void;
    const nativeRestoreEntered = createDeferred<void>();
    const nativeRestore = new Promise<void>(resolve => { finishNativeRestore = resolve; });
    restore.mockReset().mockImplementationOnce(() => { nativeRestoreEntered.resolve(); return nativeRestore; });
    await withGeneratedElevenLabs(async ({ lifecycle, assembly, adapter, getUserMedia }) => {
      try {
        await lifecycle.toggle(null);
        expect(adapter.getSnapshot().status).toBe('connected');
        expect(configure).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ input: true, output: true, capture: 'provider_managed_exclusive' }) }));
        const firstDispose = assembly.dispose();
        const secondDispose = assembly.dispose();
        expect(secondDispose).toBe(firstDispose);
        let settled = false;
        void firstDispose.then(() => { settled = true; });
        await Promise.race([nativeRestoreEntered.promise, firstDispose]);
        expect(restore).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        finishNativeRestore();
        await Promise.race([sdkStopEntered.promise, firstDispose]);
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        finishSdkStop();
        await Promise.all([firstDispose, secondDispose]);
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(vendor.setAudioModeAsync).not.toHaveBeenCalled();
      } finally {
        finishNativeRestore();
        finishSdkStop();
        restore.mockResolvedValue(undefined);
      }
    }, 'ios');
  });

  it('cannot start SDK capture when the generated adapter registration is removed', async () => {
    vendor.startSession.mockReset().mockResolvedValue(createVendorConversation());
    await withGeneratedElevenLabs(async ({ lifecycle, adapter, assembly, getUserMedia }) => {
      await assembly.dispose();
      registerVoiceAdapters(assembly.adapters.filter(value => value.id !== adapter.id));
      await lifecycle.toggle(null);
      expect(lifecycle.getSnapshot().status).not.toBe('connected');
      expect(vendor.startSession).not.toHaveBeenCalled();
      expect(vendor.setAudioModeAsync).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  it('acquires the canonical audio lease before SDK capture, projects physical mute and releases the lease at End', async () => {
    const conversation = createVendorConversation();
    vendor.startSession.mockReset().mockResolvedValue(conversation);
    await withGeneratedElevenLabs(async ({ lifecycle, adapter, getUserMedia }) => {
      await lifecycle.toggle(null);
      expect(lifecycle.getSnapshot().status).toBe('connected');
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(vendor.setAudioModeAsync.mock.calls[0]?.[0]).toMatchObject({ allowsRecording: true, shouldPlayInBackground: true });
      expect(vendor.setAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(vendor.startSession.mock.invocationCallOrder[0]!);
      expect(getUserMedia).not.toHaveBeenCalled();
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
      expect(conversation.isMuted()).toBe(true);
      expect(adapter.getSnapshot().micMuted).toBe(true);
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: false });
      expect(conversation.isMuted()).toBe(false);
      expect(adapter.getSnapshot().micMuted === true).toBe(false);
      await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
      expect(conversation.endSession).toHaveBeenCalledTimes(1);
      expect(adapter.getSnapshot().status).toBe('disconnected');
      expect(vendor.setAudioModeAsync.mock.calls.at(-1)?.[0]).toEqual({ shouldPlayInBackground: false });
      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])('applies the latest provider mute (%s) before a delayed SDK conversation becomes connected', async muted => {
    const conversation = createVendorConversation();
    const sdkStarted = createDeferred<void>();
    const sdkConnected = createDeferred<typeof conversation>();
    vendor.startSession.mockReset().mockImplementation(() => {
      sdkStarted.resolve();
      return sdkConnected.promise;
    });
    await withGeneratedElevenLabs(async ({ lifecycle, adapter }) => {
      const starting = lifecycle.toggle(null);
      await Promise.race([sdkStarted.promise, starting]);
      expect(vendor.startSession).toHaveBeenCalledTimes(1);
      expect(adapter.getSnapshot().status).toBe('connecting');
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: !muted });
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted });
      expect(conversation.setMicMuted).not.toHaveBeenCalled();
      sdkConnected.resolve(conversation);
      await starting;
      expect(conversation.isMuted()).toBe(muted);
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(adapter.getSnapshot().micMuted === true).toBe(muted);
      expect(conversation.setMicMuted.mock.calls[0]).toEqual([muted]);
    });
  });

  it('retires the actual provider attempt and audio lease when SDK muting rejects silence', async () => {
    const conversation = createVendorConversation();
    vendor.startSession.mockReset().mockResolvedValue(conversation);
    await withGeneratedElevenLabs(async ({ lifecycle, adapter, getUserMedia }) => {
      await lifecycle.toggle(null);
      conversation.setMicMuted.mockImplementation(value => {
        if (value) throw new Error('vendor_capture_mute_rejected');
      });
      await expect(adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true })).rejects.toThrow('vendor_capture_mute_rejected');
      await waitForTestEvent(adapter.subscribe!, () => adapter.getSnapshot().status, status => status !== 'connected');
      expect(adapter.getSnapshot().status).not.toBe('connected');
      expect(conversation.endSession).toHaveBeenCalledTimes(1);
      expect(vendor.setAudioModeAsync.mock.calls.at(-1)?.[0]).toEqual({ shouldPlayInBackground: false });
      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });

  it('preserves the connected muted capture when the SDK refuses an Unmute', async () => {
    const conversation = createVendorConversation();
    vendor.startSession.mockReset().mockResolvedValue(conversation);
    await withGeneratedElevenLabs(async ({ lifecycle, adapter }) => {
      await lifecycle.toggle(null);
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
      conversation.setMicMuted.mockImplementation(value => {
        if (!value) throw new Error('vendor_unmute_rejected');
      });
      await expect(adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: false })).rejects.toThrow('vendor_unmute_rejected');
      expect(conversation.isMuted()).toBe(true);
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
      expect(conversation.endSession).not.toHaveBeenCalled();
      await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
      expect(conversation.isMuted()).toBe(true);
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
    });
  });

  it('closes a late SDK conversation after cancellation without publishing connected or retaining its audio lease', async () => {
    const conversation = createVendorConversation();
    const sdkStarted = createDeferred<void>();
    const sdkConnected = createDeferred<typeof conversation>();
    const sdkEnded = createDeferred<void>();
    conversation.endSession.mockImplementation(async () => { sdkEnded.resolve(); });
    vendor.startSession.mockReset().mockImplementation(() => {
      sdkStarted.resolve();
      return sdkConnected.promise;
    });
    await withGeneratedElevenLabs(async ({ lifecycle, adapter, getUserMedia }) => {
      const statuses: string[] = [];
      const unsubscribe = adapter.subscribe?.(() => statuses.push(adapter.getSnapshot().status));
      try {
        const starting = lifecycle.toggle(null);
        await Promise.race([sdkStarted.promise, starting]);
        expect(vendor.startSession).toHaveBeenCalledTimes(1);
        await lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(adapter.getSnapshot().status).toBe('disconnected');
        expect(vendor.setAudioModeAsync.mock.calls.at(-1)?.[0]).toEqual({ shouldPlayInBackground: false });
        sdkConnected.resolve(conversation);
        await starting;
        await sdkEnded.promise;
        expect(conversation.endSession).toHaveBeenCalledTimes(1);
        expect(statuses).not.toContain('connected');
        expect(getUserMedia).not.toHaveBeenCalled();
      } finally {
        unsubscribe?.();
        sdkConnected.resolve(conversation);
      }
    });
  });
});
