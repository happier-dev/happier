import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { RealtimeVoiceProviderRuntime } from '@happier-dev/plugin-sdk/voice/client';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from './bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

function createDeferredVoid() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('createBundledRealtimeProviderRuntime mute ownership', () => {
  it('keeps projected and provider mute state current without mutating the host mic', async () => {
    const pluginId = 'conformance.voice.async-mute';
    const localId = 'provider-managed';
    const providerId = `${pluginId}/${localId}`;
    const runtimeMachine = createVoiceConversationRuntimeMachine();
    runtimeMachine.reset();
    const settledInitialMute = createDeferredVoid();
    const delayedUnmuteA = createDeferredVoid();
    const delayedMuteB = createDeferredVoid();
    const rejectedUnmute = createDeferredVoid();
    const delayedReplacedUnmute = createDeferredVoid();
    const replacedUnmuteEntered = createDeferred<void>();
    const delayedReplacedMute = createDeferredVoid();
    const rejectedTerminalMute = createDeferredVoid();
    const providerCapture = { muted: false };
    const providerSettlements: boolean[] = [];
    const providerOperations = [
      { muted: false, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: false, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: true, deferred: settledInitialMute },
      { muted: false, deferred: delayedUnmuteA },
      { muted: true, deferred: delayedMuteB },
      { muted: false, deferred: rejectedUnmute },
      { muted: true, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: false, deferred: delayedReplacedUnmute },
      { muted: false, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: false, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: true, deferred: delayedReplacedMute },
      { muted: false, deferred: (() => { const value = createDeferredVoid(); value.resolve(); return value; })() },
      { muted: true, deferred: rejectedTerminalMute },
    ];
    const setInputMuted = vi.fn(async (muted: boolean) => {
      const operation = providerOperations.shift();
      if (!operation || operation.muted !== muted) {
        throw new Error('unexpected_provider_mute_operation');
      }
      if (operation.deferred === delayedReplacedUnmute) replacedUnmuteEntered.resolve();
      await operation.deferred.promise;
      providerCapture.muted = muted;
      providerSettlements.push(muted);
    });
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const observedController: { current: ReturnType<typeof hostLease.host.createConversationController> | null } = { current: null };
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    onTestFinished(async () => {
      settledInitialMute.resolve();
      delayedUnmuteA.resolve();
      delayedMuteB.resolve();
      rejectedUnmute.resolve();
      delayedReplacedUnmute.resolve();
      delayedReplacedMute.resolve();
      rejectedTerminalMute.resolve();
      try { await scope?.unwind(); }
      finally {
        hostLease.revoke();
        try { await environment.dispose(); }
        finally { browser.restore(); }
      }
    });
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public asynchronous microphone SDK', kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false, interruptionPolicy: 'disabled' } },
      client: { artifactId: 'async-mute-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const sdkOpen = vi.fn(async () => undefined);
    // This independently authored public SDK has asynchronous mute. Shipped
    // ElevenLabs has a synchronous hook and is not made to promise this phase.
    const publicRuntime: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'provider_managed', setInputMuted,
      protocol: {
        async prepare({ signal }) {
          return signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } };
        },
        decodeControl: () => [],
        encodeTurnControl: () => null,
      },
      async createConnection({ media }) {
        return media.createSdkHandleConnection({ driver: {
          open: sdkOpen,
          async sendControl() {},
          async close() {},
        } });
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ kind: 'continue' }),
      encodeContextUpdate: () => [], encodeTextTurn: () => [],
    };
    scope = createExternalVoiceProviderActivationScope({
      pluginId, occurrenceId: 'async-mute-occurrence', declarations: [declaration], hostPlatform: 'web',
      runtimeHost: {
        ...hostLease.host,
        createMicSession: browser.createMicSession,
        createConversationController(input) {
          observedController.current = hostLease.host.createConversationController(input);
          return observedController.current;
        },
      },
      isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
    });
    scope.api.voiceProviders.register(localId, publicRuntime);
    await scope.commit();
    const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
    if (!adapter) throw new Error('Public asynchronous provider was not registered');
    registerVoiceAdapters([adapter]);
    await environment.configureVoice({
      ...environment.persistedAccountSettings.voice, providerId,
      providers: { ...environment.persistedAccountSettings.voice.providers, [providerId]: { schemaVersion: 1, config: {} } },
    });
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const runtime = { adapter, dispose: () => scope!.unwind() };
    const assertNoHostCaptureMutation = () => {
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(browser.micSession.setMuted).not.toHaveBeenCalled();
      expect(browser.micTracks).toHaveLength(0);
    };

    try {
      await runtime.adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      expect(setInputMuted).toHaveBeenCalledWith(false);
      const initialMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      assertNoHostCaptureMutation();
      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);

      settledInitialMute.resolve();
      await initialMute;
      expect(providerCapture.muted).toBe(true);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);

      const unmuteA = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      assertNoHostCaptureMutation();
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      const muteB = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      assertNoHostCaptureMutation();
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);

      delayedMuteB.resolve();
      delayedUnmuteA.resolve();
      await Promise.all([unmuteA, muteB]);

      expect(providerCapture.muted).toBe(true);
      expect(providerSettlements).toEqual([false, false, true, false, true]);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      assertNoHostCaptureMutation();

      const failedUnmute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      rejectedUnmute.reject(new Error('provider_input_mute_rejected'));
      await expect(failedUnmute).rejects.toThrow('provider_input_mute_rejected');
      const callsAfterRejectedUnmute = setInputMuted.mock.calls.length;
      await runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });

      expect(providerCapture.muted).toBe(true);
      expect(setInputMuted).toHaveBeenCalledTimes(callsAfterRejectedUnmute);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      assertNoHostCaptureMutation();

      // Reapplication is driven by the actual controller reconnect lifecycle,
      // not by manually invoking its private connection-ready dependency.
      if (!observedController.current) throw new Error('Actual conversation controller absent');
      expect(await observedController.current.requestReconnect()).toBe(true);
      expect(setInputMuted).toHaveBeenLastCalledWith(true);

      const replacedUnmute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      await replacedUnmuteEntered.promise;
      expect(setInputMuted).toHaveBeenCalledTimes(8);
      // Replacement is a lifecycle boundary, not a second concurrent Start on
      // the same adapter. Stop must retire the old attempt without joining a
      // public provider hook that may remain pending indefinitely.
      await runtime.adapter.stop({ sessionId: controlSessionId });
      const opensBeforeReplacement = sdkOpen.mock.calls.length;
      const replacementStart = runtime.adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      await expect(replacementStart).rejects.toThrow('voice_input_mute_failed');

      // The replacement attempt must fail closed before entering the same
      // provider-owned capture side effect while retired attempt A can still
      // settle afterward and physically unmute it. The public hook has no
      // cancellation signal, so Start must remain bounded without overlapping.
      expect(setInputMuted).toHaveBeenCalledTimes(8);
      expect(sdkOpen).toHaveBeenCalledTimes(opensBeforeReplacement);
      expect(providerCapture.muted).toBe(true);

      delayedReplacedUnmute.resolve();
      await replacedUnmute;
      await runtime.adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      expect(sdkOpen).toHaveBeenCalledTimes(opensBeforeReplacement + 1);

      const replacementMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      delayedReplacedMute.resolve();
      await replacementMute;

      expect(providerCapture.muted).toBe(true);
      expect(providerSettlements).toEqual([
        false, false, true, false, true, true, false, false, false, true,
      ]);
      expect(setInputMuted.mock.calls.map(([muted]) => muted)).toEqual([
        false, false, true, false, true, false, true, false, false, false, true,
      ]);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      assertNoHostCaptureMutation();

      await runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      const failedMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      assertNoHostCaptureMutation();
      rejectedTerminalMute.reject(new Error('provider_input_mute_rejected'));
      await expect(failedMute).rejects.toThrow('provider_input_mute_rejected');
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => expect(['disconnected', 'error']).toContain(
        runtimeMachine.getSnapshot().state,
      ));
      assertNoHostCaptureMutation();
    } finally {
      settledInitialMute.resolve();
      delayedUnmuteA.resolve();
      delayedMuteB.resolve();
      rejectedUnmute.resolve();
      delayedReplacedUnmute.resolve();
      delayedReplacedMute.resolve();
      rejectedTerminalMute.resolve();
      await runtime.dispose();
      runtimeMachine.reset();
    }
  });
});
