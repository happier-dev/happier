import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { PluginContributesV2Schema} from '@happier-dev/protocol/plugins/contributions/v2';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { type VoiceRealtimeJsonValue } from '@happier-dev/protocol/voice/realtime/events';
import type {
  BundledRetiringDirectMediaTranscriptDrain,
  BundledRealtimeProviderRuntimeHost,
} from '@/voice/registry/bundledConversationRuntimeContract';
import type {
  VoiceRealtimeConnection,
  VoiceTurnControlAction,
  RealtimeVoiceProviderRuntime,
  VoiceSdkHandleConnectionDriver,
} from '@happier-dev/plugin-sdk/voice/client';

import {
  createVoiceConversationController,
  type VoiceConversationController,
  type VoiceConversationControllerDeps,
  type VoiceConversationControllerStartResult,
} from '@/voice/runtime/controller/VoiceConversationController';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { log } from '@/log';

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from './bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from './externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from './externalVoiceProviderRegistrations';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-audio', async () =>
  (await import('@/dev/testkit/mocks/expoAudio')).expoAudioModuleMock());
const platform = vi.hoisted(() => ({ current: 'web' as 'web' | 'ios' }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { get OS() { return platform.current; } } }));
// Native module lookup can happen while the runtime's import graph initializes.
// Install the genuine native boundary before that first, process-owned lookup.
const nativeAudio = await vi.hoisted(async () => {
  const { createNativeVoicePcmCaptureHarness } = await import('@/dev/testkit/harness/nativeVoicePcmCapture');
  return createNativeVoicePcmCaptureHarness();
});
vi.mock('expo-modules-core', async original => {
  const actual = await original<typeof import('expo-modules-core')>();
  return { ...actual, requireOptionalNativeModule: (name: string) =>
    name === 'HappierAudioStreamNative' ? nativeAudio.nativeModule : actual.requireOptionalNativeModule(name) };
});

const createDeferredVoid = createDeferred<void>;

function isControlRecord(value: VoiceRealtimeJsonValue): value is Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runCurrentGenerationEffect(callback: () => void): boolean {
  callback();
  return true;
}

describe('createBundledRealtimeProviderRuntime', () => {
  const fixtureSessionIds = [
    'shared-control-session',
    'target-session',
    'session-1',
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-6',
    'session-unsafe-code',
  ] as const;
  let previousSessions: ReturnType<typeof storage.getState>['sessions'];

  beforeEach(() => {
    previousSessions = storage.getState().sessions;
    storage.setState((current) => ({
      ...current,
      sessions: Object.fromEntries(fixtureSessionIds.map((sessionId) => [
        sessionId,
        createSessionFixture({ id: sessionId, serverId: 'server-a' }),
      ])),
    }) as never);
  });

  afterEach(() => {
    platform.current = 'web';
    storage.setState((current) => ({ ...current, sessions: previousSessions }) as never);
  });

  it('settles A provider custody before replacement B, without letting A transcript drain stop B', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () =>
      new TestVoiceAudioContext() as unknown as AudioContext });
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.overlap';
    const localId = 'sdk';
    const providerId = `${pluginId}/${localId}`;
    const controlSessionId = environment.historySessionId;
    const targetAddress = { serverId: environment.accountConnection.home.id, sessionId: controlSessionId };
    const firstCarrierAcquisition = createDeferredVoid();
    const carrierAcquisitionStarted = createDeferredVoid();
    const staleConnectionClose = createDeferredVoid();
    const firstWriteStarted = createDeferredVoid();
    const releaseFirstWrite = createDeferredVoid();
    const callbacks = new Map<number, Parameters<VoiceSdkHandleConnectionDriver['open']>[0]>();
    const providerOpen = new Map<number, boolean>();
    const providerControls: Array<{ attemptId: number; event: VoiceRealtimeJsonValue }> = [];
    const replacementTextSent = createDeferredVoid();
    const preparationReleases: number[] = [];
    let activeProviderPreparation: number | null = null;
    let preparationCount = 0;
    let transcriptSequence = 0;
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    let staleStop: Promise<void> | null = null;
    const { createVoiceTranscriptLadderMapper } = await import('@happier-dev/plugin-sdk/voice/client');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { writeSessionVoicePreferenceV1ToMetadata } = await import('@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1');
    const { sync } = await import('@/sync/sync');
    const ladder = createVoiceTranscriptLadderMapper();
    const serveMetadata = environment.sessionHttp.handle.bind(environment.sessionHttp);
    let heldCarrier = false;
    vi.spyOn(environment.sessionHttp, 'handle').mockImplementation((input, init) => {
      const response = serveMetadata(input, init);
      if (!response || heldCarrier || init?.method === 'PATCH'
        || new URL(String(input)).pathname !== `/v2/sessions/${controlSessionId}`) return response;
      heldCarrier = true;
      carrierAcquisitionStarted.resolve();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await firstCarrierAcquisition.promise;
          controller.enqueue(new TextEncoder().encode(await response.text()));
          controller.close();
        },
      }), { status: response.status, headers: response.headers });
    });
    environment.transcriptRequest.mockImplementation(async (input, init) => {
      const response = await environment.homeRequest(input, init);
      if (response) return response;
      expect(String(input)).toBe(environment.transcriptMessageUrl(controlSessionId));
      expect(init?.method).toBe('POST');
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== 'object' || !('localId' in body)) throw new Error('Expected transcript request');
      const sequence = ++transcriptSequence;
      if (sequence === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      return Response.json({ didWrite: true, message: {
        id: `overlap-transcript-${sequence}`, seq: sequence, localId: body.localId, createdAt: Date.now(),
      } });
    });
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public overlap SDK', kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      settings: environment.entry.declaration.settings,
      client: { artifactId: 'overlap-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const provider: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'host_pcm',
      protocol: {
        async prepare({ attemptId }) {
          preparationCount += 1;
          activeProviderPreparation = attemptId;
          return { kind: 'prepared', session: { config: null, safeMetadata: null } };
        },
        async releasePrepared({ attemptId }) {
          preparationReleases.push(attemptId);
          if (activeProviderPreparation === attemptId) activeProviderPreparation = null;
        },
        decodeControl(event) {
          if (!isControlRecord(event)
            || typeof event.text !== 'string' || typeof event.item !== 'string'
            || typeof event.id !== 'string') return [];
          const transcript = ladder.map({ itemId: event.item, eventId: event.id, role: 'user',
            incoming: event.text, mode: 'final' });
          return transcript ? [{ type: 'transcript', event: transcript }] : [];
        },
        encodeTurnControl: () => null,
      },
      async createConnection({ media, attemptId, mic }) {
        return media.createPcmConnection({ driver: {
          async open(input) { callbacks.set(attemptId, input); providerOpen.set(attemptId, true); },
          async sendControl(event) {
            if (!providerOpen.get(attemptId)) throw new Error('voice_connection_not_open');
            if (!mic.getStream()) throw new Error('replacement_mic_released');
            if (activeProviderPreparation !== attemptId) throw new Error('replacement_preparation_released');
            providerControls.push({ attemptId, event });
            if (attemptId === 2 && isControlRecord(event) && event.type === 'input_text') replacementTextSent.resolve();
          },
          async close() {
            if (attemptId === 1) await staleConnectionClose.promise;
            providerOpen.set(attemptId, false);
          },
        }, input: { sampleRate: 24_000, chunkMs: 100 }, output: { sampleRate: 24_000 },
          onInputChunk: () => {},
        }).connection;
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ type: 'unused' }),
      encodeContextUpdate: () => [], encodeTextTurn: text => [{ type: 'input_text', text }],
    };
    try {
      scope = createExternalVoiceProviderActivationScope({
        pluginId, occurrenceId: 'overlap-occurrence', declarations: [declaration], hostPlatform: 'web',
        runtimeHost: { ...hostLease.host, createMicSession: browser.createMicSession },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
      });
      scope.api.voiceProviders.register(localId, provider);
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter) throw new Error('Public overlap provider was not registered');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { ...environment.persistedAccountSettings.voice.providers, [providerId]: {
          schemaVersion: 1, config: environment.persistedAccountSettings.voice.providers[environment.entry.providerId]!.config,
        } } });

      const session = storage.getState().sessions[controlSessionId];
      if (!session?.metadata) throw new Error('Expected the canonical history fixture');
      storage.setState({ sessions: { ...storage.getState().sessions, [controlSessionId]: {
        ...session, metadata: writeSessionVoicePreferenceV1ToMetadata(session.metadata, {
          providerContributionId: providerId, settingFieldPath: 'voice', value: 'marin',
        }),
      } } });
      environment.sessionHttp.replaceSession(controlSessionId);

      const firstStart = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: targetAddress });
      await carrierAcquisitionStarted.promise;
      expect(browser.captures).toEqual([]);
      expect(callbacks.size).toBe(0);
      firstCarrierAcquisition.resolve();
      await firstStart;
      expect(adapter.getSnapshot().inUseVoice).toMatchObject({ value: 'marin' });
      callbacks.get(1)!.onControl({ id: 'a-final', item: 'a-final', text: 'A admitted before replacement' });
      await firstWriteStarted.promise;
      const firstTrack = browser.micTrack;
      staleStop = adapter.stop({ sessionId: controlSessionId });
      await sync.patchSessionMetadataWithRetry(controlSessionId, metadata =>
        writeSessionVoicePreferenceV1ToMetadata(metadata, {
          providerContributionId: providerId, settingFieldPath: 'voice', value: 'cedar',
        }));
      const replacementStart = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: targetAddress });
      await Promise.resolve();
      expect(preparationCount).toBe(1);
      expect(providerOpen.get(1)).toBe(true);
      staleConnectionClose.resolve();
      await replacementStart;
      const replacementTrack = browser.micTrack;
      expect(replacementTrack).not.toBe(firstTrack);
      expect(firstTrack.readyState).toBe('ended');
      expect(replacementTrack.readyState).toBe('live');
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', inUseVoice: { value: 'cedar' } });
      expect(activeProviderPreparation).toBe(2);
      let staleStopSettled = false;
      void staleStop.then(() => { staleStopSettled = true; });
      await Promise.resolve();
      expect(staleStopSettled).toBe(false);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId);
      expect(binding?.conversationSessionId).toBe(controlSessionId);
      const runtimeBinding = voiceSessionBindingStore.getState().runtimeBindingsByConversationSessionId[controlSessionId];
      expect(runtimeBinding).toBeDefined();

      callbacks.get(2)!.onControl({ id: 'b-final', item: 'b-final', text: 'replacement B is still live' });
      const textTurn = adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: controlSessionId, text: 'continue on B' })({ localId: 'replacement-b-text', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} });
      await Promise.race([replacementTextSent.promise, textTurn]);
      expect(providerControls).toContainEqual({
        attemptId: 2, event: { type: 'input_text', text: 'continue on B' },
      });
      releaseFirstWrite.resolve();
      await Promise.all([staleStop, textTurn]);
      expect(voiceSessionBindingStore.getState().runtimeBindingsByConversationSessionId[controlSessionId]).toBe(runtimeBinding);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId)).toEqual(binding);
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(replacementTrack.readyState).toBe('live');
      expect(activeProviderPreparation).toBe(2);
      await waitForTestEvent(storage.subscribe, () => readStoredSessionMessages(storage.getState(), controlSessionId), messages => messages.some(message => message && typeof message === 'object' && 'kind' in message && message.kind === 'user-text' && 'text' in message && message.text === 'replacement B is still live'));
      expect(readStoredSessionMessages(storage.getState(), controlSessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'user-text', text: 'A admitted before replacement' }),
          expect.objectContaining({ kind: 'user-text', text: 'replacement B is still live' }),
        ]),
      );
      await adapter.stop({ sessionId: controlSessionId });
      expect(replacementTrack.readyState).toBe('ended');
      expect(activeProviderPreparation).toBeNull();
      expect(preparationReleases).toEqual([1, 2]);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId)).toBeNull();
    } finally {
      firstCarrierAcquisition.resolve();
      staleConnectionClose.resolve();
      releaseFirstWrite.resolve();
      await staleStop?.catch(() => {});
      await scope?.unwind();
      hostLease.revoke();
      browser.restore();
      await environment.dispose();
    }
  });

  it('admits pending mute and joins disposal through a registered provider-managed public SDK', async () => {
    platform.current = 'ios';
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.provider-managed';
    const localId = 'sdk';
    const providerId = `${pluginId}/${localId}`;
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const preparationStarted = createDeferredVoid();
    const releasePreparation = createDeferredVoid();
    const closeStarted = createDeferredVoid();
    const releaseClose = createDeferredVoid();
    const nativeAcquisitionStarted = createDeferredVoid();
    const releaseNativeAcquisition = createDeferredVoid();
    let pendingSdkClose: ReturnType<typeof createDeferredVoid> | null = null;
    const providerCapture = { muted: false, active: false };
    const appliedMute: boolean[] = [];
    const controls: VoiceRealtimeJsonValue[] = [];
    let closeCount = 0;
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    const observation: { deps: VoiceConversationControllerDeps | null; controller: VoiceConversationController | null } = {
      deps: null, controller: null,
    };
    const preparationInputs: Array<Parameters<RealtimeVoiceProviderRuntime['protocol']['prepare']>[0]> = [];
    const configureNativeAudio = vi.mocked(nativeAudio.nativeModule.configureAudioSession);
    const restoreNativeAudio = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
    restoreNativeAudio.mockResolvedValue(undefined);
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public provider-managed capture', kind: 'conversation',
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'], platforms: ['ios'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'provider-managed-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const provider: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'provider_managed',
      setInputMuted(muted) { providerCapture.muted = muted; appliedMute.push(muted); },
      protocol: {
        async prepare(input) {
          preparationInputs.push(input);
          preparationStarted.resolve();
          await releasePreparation.promise;
          return input.signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } };
        },
        decodeControl: () => [], encodeTurnControl: () => null,
      },
      async createConnection({ media }) {
        return media.createSdkHandleConnection({ driver: {
          async open() { providerCapture.active = true; },
          async sendControl(event) { controls.push(event); },
          async close() {
            closeCount += 1;
            closeStarted.resolve();
            await pendingSdkClose?.promise;
            providerCapture.active = false;
          },
        } });
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ type: 'unused' }),
      encodeContextUpdate: () => [], encodeTextTurn: () => [],
    };
    let starting: Promise<void> | null = null;
    try {
      scope = createExternalVoiceProviderActivationScope({
        pluginId, occurrenceId: 'provider-managed-occurrence', declarations: [declaration], hostPlatform: 'ios',
        runtimeHost: { ...hostLease.host, createMicSession: browser.createMicSession,
          createConversationController(input) {
            observation.deps = input;
            observation.controller = hostLease.host.createConversationController(input);
            return observation.controller;
          },
        },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
      });
      scope.api.voiceProviders.register(localId, provider);
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter) throw new Error('Public provider-managed runtime was not registered');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { ...environment.persistedAccountSettings.voice.providers, [providerId]: { schemaVersion: 1, config: {} } } });
      starting = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      await preparationStarted.promise;
      expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(false);
      await adapter.setMuted({ sessionId: controlSessionId, muted: true });
      expect(providerCapture.muted).toBe(true);
      releasePreparation.resolve();
      await starting;
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
      expect(providerCapture).toEqual({ active: true, muted: true });
      expect(appliedMute.every(muted => muted)).toBe(true);
      expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(browser.micSession.setMuted).not.toHaveBeenCalled();
      expect(browser.captures).toEqual([]);
      await expect(adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'unsupported typed turn' })({ localId: 'provider-managed-unsupported', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} })).rejects.toThrow('voice_text_turn_unsupported');
      expect(controls).toEqual([]);
      const coordinator = getSharedVoiceAudioSessionCoordinator();
      if (!coordinator) throw new Error('Expected the real native audio coordinator');
      expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 1, configuration: { input: true, output: true, capture: 'provider_managed_exclusive' } });
      await adapter.stop({ sessionId: controlSessionId });
      expect(coordinator.getSnapshot().leaseCount).toBe(0);
      configureNativeAudio.mockImplementationOnce(async input => {
        nativeAcquisitionStarted.resolve();
        await releaseNativeAcquisition.promise;
        return { generation: input.generation, aecAvailable: true, aecActive: true, route: 'speaker' };
      });
      const attemptA = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      await nativeAcquisitionStarted.promise;
      const stalePreparation = preparationInputs.at(-1);
      if (!stalePreparation) throw new Error('Missing real attempt preparation');
      const nativeCallsBeforeReplacement = configureNativeAudio.mock.calls.length;
      let stoppedA = false;
      const stoppingA = adapter.stop({ sessionId: controlSessionId }).then(() => { stoppedA = true; });
      const attemptB = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      await Promise.resolve();
      expect(stoppedA).toBe(false);
      expect(configureNativeAudio).toHaveBeenCalledTimes(nativeCallsBeforeReplacement);
      releaseNativeAcquisition.resolve();
      await Promise.all([attemptA, stoppingA, attemptB]);
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(coordinator.getSnapshot().leaseCount).toBe(1);
      const deps = observation.deps;
      if (!deps?.resources) throw new Error('Missing observed real resource owner');
      const nativeCallsBeforeStalePrepare = configureNativeAudio.mock.calls.length;
      // Replay a genuinely produced retired id with a fresh operation signal;
      // stale ownership must refuse before another native lease is acquired.
      await expect(deps.resources.prepare({ ...stalePreparation, signal: new AbortController().signal }))
        .rejects.toThrow('voice_transcript_attempt_ownership_mismatch');
      expect(configureNativeAudio).toHaveBeenCalledTimes(nativeCallsBeforeStalePrepare);
      pendingSdkClose = releaseClose;
      const priorCloseCount = closeCount;
      let firstSettled = false;
      let secondSettled = false;
      const firstDispose = Promise.resolve(scope.unwind()).then(() => { firstSettled = true; });
      await closeStarted.promise;
      const secondDispose = Promise.resolve(scope.unwind()).then(() => { secondSettled = true; });
      await Promise.resolve();
      expect(closeCount).toBe(priorCloseCount + 1);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      releaseClose.resolve();
      await Promise.all([firstDispose, secondDispose]);
      expect(closeCount).toBe(priorCloseCount + 1);
      expect(providerCapture.active).toBe(false);
      expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(false);
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(browser.micSession.setMuted).not.toHaveBeenCalled();
    } finally {
      releasePreparation.resolve();
      releaseClose.resolve();
      releaseNativeAcquisition.resolve();
      await starting?.catch(() => {});
      await scope?.unwind();
      hostLease.revoke();
      browser.restore();
      await environment.dispose();
      platform.current = 'web';
    }
  });

  it('keeps the host lifecycle owner while forwarding mute to provider-managed exclusive media', async () => {
    const setInputMuted = vi.fn(async () => undefined);
    const resolveConversationBinding = vi.fn(async (input: Readonly<{
      controlSessionId: string;
      requestedTargetSessionAddress: Readonly<{ serverId: string; sessionId: string }> | null;
      settings: unknown;
    }>) => ({
      conversationSessionAddress: { serverId: 'server-a', sessionId: input.controlSessionId },
      transcriptMode: 'native_session' as const,
      targetSessionAddress: input.requestedTargetSessionAddress,
    }));
    const releaseAudioMode = vi.fn(async () => undefined);
    const acquireAudioMode = vi.fn<BundledRealtimeProviderRuntimeHost['acquireAudioMode']>(
      async () => ({ release: releaseAudioMode }),
    );
    let micMuted = false;
    const mic = {
      ensureActive: vi.fn(async () => undefined),
      teardown: vi.fn(async () => undefined),
      setMuted: vi.fn((muted: boolean) => {
        micMuted = muted;
      }),
      isMuted: vi.fn(() => micMuted),
      getStream: vi.fn(() => null),
      getAudioContext: vi.fn(() => null),
    };
    const providerManagedInputWriter = {
      write: vi.fn(),
      reset: vi.fn(),
      close: vi.fn(),
    };
    const openLevelWriter = vi.fn(() => providerManagedInputWriter);
    let selectedProviderId = 'realtime_sdk';
    let providerConfig: Readonly<Record<string, unknown>> = {
      authentication: { source: 'voice_saved_secret' },
    };
    let controllerInput: VoiceConversationControllerDeps | null = null;
    // Retain only the legacy overrides for this resource oracle. New operations
    // come from the real controller; an overridden start does not prove Hold
    // to talk composition, which the real-controller suites exercise separately.
    const controller = {
      start: vi.fn(async (): Promise<VoiceConversationControllerStartResult> => ({ status: 'connected' })),
      stop: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      performTurnControl: vi.fn(async () => ({
        status: 'unavailable' as const,
        code: 'voice_turn_action_unsupported' as const,
      })),
      sendClientControl: vi.fn(async () => ({ status: 'sent' as const })),
      getActiveControlSessionId: vi.fn(() => null),
      canCommitInput: () => false,
      getOwnedControlSessionId: vi.fn(() => 'voice-global'),
      getOwnedAttemptId: vi.fn(() => 1),
      requestReconnect: vi.fn(async () => false),
      playbackCursorMs: vi.fn(() => null),
      beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    } satisfies Partial<VoiceConversationController>;
    const host = {
      globalVoiceSessionId: 'voice-global',
      runCurrentGenerationEffect,
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId: selectedProviderId } }),
      projectVoiceSettings: () => ({ providerId: selectedProviderId, providerConfig }),
      machine: {
        transitionToAcquiringMic: vi.fn(), transitionToConnecting: vi.fn(), transitionToConnected: vi.fn(),
        setReconnecting: vi.fn(), transitionToSpeaking: vi.fn(), transitionToEnding: vi.fn(),
        transitionToDisconnected: vi.fn(), setError: vi.fn(), setMuted: vi.fn(),
        getSnapshot: vi.fn(() => ({ status: 'disconnected' })),
        projectSnapshot: vi.fn(() => ({ adapterId: 'realtime_sdk', sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false })),
        subscribe: vi.fn(() => vi.fn()),
      },
      createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
        controllerInput = input;
        return { ...createVoiceConversationController(input), ...controller };
      }),
      createMicSession: vi.fn(() => mic),
      createSdkHandleConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebRtcConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmMedia: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmConnection: vi.fn(() => { throw new Error('unused'); }),
      ensureBound: vi.fn(async () => undefined),
      acquireDirectMediaConversation: vi.fn(({ controlSessionId }) => ({
        conversationSessionId: controlSessionId,
      })),
      releaseDirectMediaConversation: vi.fn(),
      resolveConversationSessionId: vi.fn((controlSessionId: string) => controlSessionId),
      applyTargetSelection: vi.fn(),
      acquireAudioMode,
      openLevelWriter,
      projectTranscript: vi.fn(() => null),
      admitTranscriptPersistenceEvent: vi.fn(() => null),
      commitAdmittedTranscriptPersistenceEvent: vi.fn(() => null),
      releaseAdmittedTranscriptPersistenceEvent: vi.fn(() => false),
      settleTranscriptPersistence: vi.fn(async () => undefined),
      beginTranscriptAttempt: vi.fn(() => ({
        epoch: 1,
        attemptIdentity: 'attempt-1',
      })),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({ run: vi.fn(async () => ({ status: 'submitted' as const, results: [] })), cancel: vi.fn(() => false), dispose: vi.fn() })),
      voiceHooks: { onStarted: vi.fn(() => ''), onStopped: vi.fn() },
      createMachineError: vi.fn((input) => ({
        ...input, phase: 'runtime' as const, retryPolicy: 'user_action' as const,
        recoveryAction: 'retry' as const, presentation: 'error' as const, recoverable: true,
      })),
    } satisfies BundledRealtimeProviderRuntimeHost;
    const runtime = createBundledRealtimeProviderRuntime(host, {
      providerId: 'realtime_sdk',
      execution: { kind: 'direct_media' },
      protocol: {
        id: 'realtime_sdk',
        turnControls: {
          cancelResponse: 'unsupported', truncatePlayback: 'unsupported', clearInput: false,
          stopSession: false, resumption: 'none', exactMessage: true,
        },
        prepare: vi.fn(async () => ({ kind: 'declined' as const, code: 'unused' })),
        decodeControl: vi.fn(() => []),
        encodeTurnControl: vi.fn(() => null),
      },
      createConnection: vi.fn(async () => { throw new Error('unused'); }),
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
      microphoneMode: 'provider_managed',
      setInputMuted,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveConversationBinding,
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    await runtime.adapter.start({ sessionId: 'voice-global', requestedTargetSessionAddress: null });
    expect(openLevelWriter).toHaveBeenCalledWith({
      channel: 'input',
      sourceId: 'realtime_sdk:voice-global',
    });
    expect(providerManagedInputWriter.close).not.toHaveBeenCalled();
    await expect(runtime.adapter.prepareTextTurn?.({ controlSessionId: 'voice-global', conversationSessionId: 'voice-global', text: 'unsupported typed turn' })({ localId: 'voice-local-unsupported', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} })).rejects.toThrow('voice_text_turn_unsupported');

    await expect(runtime.adapter.resolveConversationBinding?.({
      controlSessionId: 'codex-session',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'target-session' },
      settings: { voice: true },
    })).resolves.toEqual({
      conversationSessionAddress: { serverId: 'server-a', sessionId: 'codex-session' },
      transcriptMode: 'native_session',
      targetSessionAddress: { serverId: 'server-a', sessionId: 'target-session' },
    });
    expect(resolveConversationBinding).toHaveBeenCalledTimes(1);

    const resources = controllerInput!.resources;
    if (!resources) throw new Error('expected runtime resources');
    await runtime.adapter.start({ sessionId: 'voice-global', requestedTargetSessionAddress: null });
    expect(controllerInput!.isSelectionCurrent()).toBe(true);
    providerConfig = {
      authentication: {
        source: 'connected_service_api_key',
        binding: { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    };
    expect(controllerInput!.isSelectionCurrent()).toBe(true);
    selectedProviderId = 'another_provider';
    expect(controllerInput!.isSelectionCurrent()).toBe(false);
    selectedProviderId = 'realtime_sdk';
    // The controller owns attempt 1 before its resource preparation begins.
    // An interruption in that interval must be retained and applied instead
    // of resolving as a no-op over a later unmuted provider resource.
    await runtime.adapter.setMuted({ sessionId: 'voice-global', muted: true });
    await resources.preflight!({
      controlSessionId: 'voice-global', attemptId: 1, request: {}, signal: new AbortController().signal,
    });
    await resources.prepare({
      controlSessionId: 'voice-global', attemptId: 1, request: {}, signal: new AbortController().signal,
    });
    await resources.release({ controlSessionId: 'voice-global', attemptId: 1, reason: { code: 'user_stop' } });
    await runtime.adapter.stop({ sessionId: 'voice-global' });
    await runtime.adapter.start({ sessionId: 'voice-global', requestedTargetSessionAddress: null });

    expect(mic.ensureActive).not.toHaveBeenCalled();
    expect(host.acquireAudioMode).toHaveBeenCalledWith('realtime_sdk');
    expect(mic.setMuted).not.toHaveBeenCalled();
    expect(setInputMuted).toHaveBeenCalledWith(true);
    expect(host.machine.setMuted).toHaveBeenCalledWith('voice-global', 'realtime_sdk', 1, true);
    expect(releaseAudioMode).toHaveBeenCalledTimes(1);

    let resolveAttemptAAudioMode!: (lease: Readonly<{ release(): Promise<void> }>) => void;
    const attemptAAudioMode = new Promise<Readonly<{ release(): Promise<void> }>>((resolve) => {
      resolveAttemptAAudioMode = resolve;
    });
    const releaseAttemptA = vi.fn(async () => undefined);
    const releaseAttemptB = vi.fn(async () => undefined);
    acquireAudioMode
      .mockImplementationOnce(() => attemptAAudioMode)
      .mockResolvedValueOnce({ release: releaseAttemptB });
    await resources.preflight!({
      controlSessionId: 'voice-global',
      attemptId: 2,
      request: {},
      signal: new AbortController().signal,
    });
    const prepareAttemptA = resources.prepare({
      controlSessionId: 'voice-global',
      attemptId: 2,
      request: {},
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(host.acquireAudioMode).toHaveBeenCalledTimes(2);
    });
    let releaseAttemptAFinished = false;
    const releaseAttemptAPromise = resources.release({
      controlSessionId: 'voice-global',
      attemptId: 2,
      reason: { code: 'user_stop' },
    }).then(() => {
      releaseAttemptAFinished = true;
    });
    await Promise.resolve();
    expect(releaseAttemptAFinished).toBe(false);

    await resources.preflight!({
      controlSessionId: 'voice-global',
      attemptId: 3,
      request: {},
      signal: new AbortController().signal,
    });
    const prepareAttemptB = resources.prepare({
      controlSessionId: 'voice-global',
      attemptId: 3,
      request: {},
      signal: new AbortController().signal,
    });
    await prepareAttemptB;
    resolveAttemptAAudioMode({ release: releaseAttemptA });
    await Promise.all([prepareAttemptA, releaseAttemptAPromise]);
    await resources.release({
      controlSessionId: 'voice-global',
      attemptId: 3,
      reason: { code: 'user_stop' },
    });

    expect(releaseAttemptA).toHaveBeenCalledTimes(1);
    expect(releaseAttemptB).toHaveBeenCalledTimes(1);
    const acquisitionCountBeforeStaleAttempt = host.acquireDirectMediaConversation.mock.calls.length;
    await expect(resources.prepare({
      controlSessionId: 'voice-global',
      attemptId: 2,
      request: {},
      signal: new AbortController().signal,
    })).rejects.toThrow('voice_transcript_attempt_ownership_mismatch');
    expect(host.acquireDirectMediaConversation).toHaveBeenCalledTimes(acquisitionCountBeforeStaleAttempt);
    const deferredDisposeStop = createDeferredVoid();
    const stopCallsBeforeDispose = controller.stop.mock.calls.length;
    controller.stop.mockImplementationOnce(async () => {
      await deferredDisposeStop.promise;
    });
    let firstDisposeSettled = false;
    let secondDisposeSettled = false;
    const firstDispose = runtime.dispose();
    void firstDispose.then(() => {
      firstDisposeSettled = true;
    });
    await vi.waitFor(() => {
      expect(controller.stop).toHaveBeenCalledTimes(stopCallsBeforeDispose + 1);
    });
    const secondDispose = runtime.dispose();
    void secondDispose.then(() => {
      secondDisposeSettled = true;
    });
    await Promise.resolve();

    expect(firstDisposeSettled).toBe(false);
    expect(secondDisposeSettled).toBe(false);
    expect(controller.stop).toHaveBeenCalledTimes(stopCallsBeforeDispose + 1);

    deferredDisposeStop.resolve();
    await Promise.all([firstDispose, secondDispose]);
    expect(firstDisposeSettled).toBe(true);
    expect(secondDisposeSettled).toBe(true);
    expect(controller.stop).toHaveBeenCalledTimes(stopCallsBeforeDispose + 1);
  });

  it('cancels a start before deferred target setup can enter or publish the conversation runtime', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const targetSelectionStarted = createDeferredVoid();
    const releaseTargetSelection = createDeferredVoid();
    const targetAddress = {
      serverId: environment.accountConnection.home.id,
      sessionId: environment.historySessionId,
    };
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const binding = voiceSessionBindingStore.getState().getByControlSessionId(composed.controlSessionId);
    if (!binding) throw new Error('Expected the recipe conversation binding');
    voiceSessionBindingStore.getState().bind({ ...binding, controlSessionId: targetAddress.sessionId });
    const serveMetadata = environment.sessionHttp.handle.bind(environment.sessionHttp);
    // Hold the real Home metadata ACK. Binding, target selection, controller
    // admission and provider activation remain in their production owners.
    vi.spyOn(environment.sessionHttp, 'handle').mockImplementation((input, init) => {
      const response = serveMetadata(input, init);
      if (!response || init?.method !== 'PATCH'
        || new URL(String(input)).pathname !== `/v2/sessions/${environment.historySessionId}`) {
        return response;
      }
      targetSelectionStarted.resolve();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await releaseTargetSelection.promise;
          controller.enqueue(new TextEncoder().encode(await response.text()));
          controller.close();
        },
      }), { status: response.status, headers: response.headers });
    });
    let starting: Promise<void> | null = null;
    try {
      starting = composed.adapter.start({
        sessionId: targetAddress.sessionId,
        requestedTargetSessionAddress: targetAddress,
      });
      await targetSelectionStarted.promise;
      expect(browser.peers).toEqual([]);
      expect(browser.captures).toEqual([]);
      expect(environment.providerFetch).not.toHaveBeenCalled();
      expect(composed.controller?.getOwnedControlSessionId() ?? null).toBeNull();

      await composed.adapter.stop({ sessionId: targetAddress.sessionId });
      releaseTargetSelection.resolve();
      await starting;

      expect(browser.peers).toEqual([]);
      expect(browser.captures).toEqual([]);
      expect(environment.providerFetch).not.toHaveBeenCalled();
      expect(composed.controller?.getOwnedControlSessionId() ?? null).toBeNull();
      expect(composed.adapter.getSnapshot()).toMatchObject({
        status: 'disconnected',
        canStop: false,
      });
    } finally {
      releaseTargetSelection.resolve();
      await starting?.catch(() => {});
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
      await environment.dispose();
    }
  });

  it('fences public media factories and stale output meters through real construction and reconnect', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.media-factory';
    const localId = 'sdk';
    const providerId = `${pluginId}/${localId}`;
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const observation: { deps: VoiceConversationControllerDeps | null; controller: VoiceConversationController | null } = {
      deps: null, controller: null,
    };
    const observedControllers: Array<{ deps: VoiceConversationControllerDeps; controller: VoiceConversationController }> = [];
    const constructionInputs: Array<Parameters<RealtimeVoiceProviderRuntime['createConnection']>[0]> = [];
    const sdkCallbacks: Array<Parameters<VoiceSdkHandleConnectionDriver['open']>[0]> = [];
    const closedConnections: Array<Parameters<VoiceSdkHandleConnectionDriver['close']>[0]> = [];
    const sentControls: VoiceRealtimeJsonValue[] = [];
    const controlSends = new EventTarget();
    const subscribeControlSends = (notify: () => void) => {
      controlSends.addEventListener('send', notify);
      return () => controlSends.removeEventListener('send', notify);
    };
    const acceptanceStarted = createDeferredVoid();
    const releaseAcceptance = createDeferredVoid();
    const stoppedAcceptanceStarted = createDeferredVoid();
    const releaseStoppedAcceptance = createDeferredVoid();
    const toolContinuationStarted = createDeferredVoid();
    const releaseNativePlayback = createDeferredVoid();
    const previousTranscriptStarted = createDeferredVoid();
    const releasePreviousTranscript = createDeferredVoid();
    let failConstruction = false;
    let preparedContextDelivery = false;
    let publishProviderConversation = false;
    let nativeProviderConversationId: string | null = null;
    let prepareFailure: string | null = null;
    let prepareDecline: string | null = null;
    let sdkOpenFailure: string | null = null;
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { VoiceRealtimeToolCallV1Schema, VoiceRealtimeToolResultV1Schema } = await import('@happier-dev/protocol/voice/realtime/events');
    const { createVoiceTranscriptLadderMapper } = await import('@happier-dev/plugin-sdk/voice/client');
    const ladder = createVoiceTranscriptLadderMapper();
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public media factory SDK', kind: 'conversation', platforms: ['web'],
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false, } },
      client: { artifactId: 'media-factory-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const preflightDeclarations = (['client_two_stage', 'provider_immediate'] as const).map(interruptionPolicy => {
      const parsed = PluginContributesV2Schema.parse({ voiceProviders: [{ ...declaration,
        id: interruptionPolicy.replaceAll('_', '-'), roles: [...declaration.roles, 'turn_control'],
        capabilities: { turn: { cancelResponse: true, bargeIn: true, interruptionPolicy } },
      }] }).voiceProviders[0]!;
      if (parsed.kind !== 'conversation') throw new Error('Expected conversation policy declaration');
      return parsed;
    });
    const driver: VoiceSdkHandleConnectionDriver = {
      async open(input) {
        if (sdkOpenFailure) throw Object.assign(new Error(sdkOpenFailure), { code: sdkOpenFailure });
        if (publishProviderConversation) nativeProviderConversationId = 'sdk-native-conversation';
        sdkCallbacks.push(input);
      },
      async sendControl(event) { sentControls.push(event); controlSends.dispatchEvent(new Event('send')); },
      async close(reason) { closedConnections.push(reason); },
    };
    const provider: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'provider_managed', setInputMuted: () => {}, outputLevelMeter: 'measured',
      protocol: {
        async prepare({ signal, request, providerConversation }) {
          if (prepareDecline) return { kind: 'declined', code: prepareDecline };
          if (prepareFailure) throw Object.assign(new Error(prepareFailure), { code: prepareFailure });
          if (signal.aborted) return { kind: 'aborted' };
          if (publishProviderConversation) {
            if (!providerConversation) throw new Error('Expected the public provider conversation persistence authority');
            await providerConversation.write('sdk-native-conversation');
          }
          const initialContext = isControlRecord(request)
            && typeof request.initialContext === 'string' ? request.initialContext : '';
          return { kind: 'prepared', session: {
            config: preparedContextDelivery ? { initialContext } : null,
            safeMetadata: null,
            ...(preparedContextDelivery ? { initialContextDelivery: 'prepared' as const } : {}),
          } };
        },
        decodeControl(event) {
          if (!isControlRecord(event)) return [];
          if (event.type === 'output_stopped') return [{ type: 'assistant_output_stopped' }];
          if (event.type === 'final' && typeof event.id === 'string' && typeof event.item === 'string' && typeof event.text === 'string') {
            const transcript = ladder.map({ itemId: event.item, eventId: event.id, role: 'user', incoming: event.text, mode: 'final' });
            return transcript ? [{ type: 'transcript', event: transcript }] : [];
          }
          if (event.type === 'tool_call' && typeof event.response === 'string' && typeof event.call === 'string'
            && typeof event.tool === 'string') return [{ type: 'tool_calls', responseId: event.response,
            calls: [VoiceRealtimeToolCallV1Schema.parse({ v: 1, responseId: event.response, callId: event.call,
              toolName: event.tool, order: 0, arguments: event.arguments ?? {} })],
          }];
          return [];
        },
        encodeTurnControl: action => action === 'cancel_response' ? { kind: 'cancel_response' } : null,
      },
      async createConnection(input) {
        constructionInputs.push(input);
        const connection = input.media.createSdkHandleConnection({ driver });
        if (failConstruction) throw Object.assign(new Error('provider_connection_creation_failed'), { code: 'provider_connection_creation_failed' });
        return connection;
      },
      encodeToolResults: results => results.map(result => ({ kind: 'tool_result', result: JSON.stringify(result) })),
      encodeToolContinuation: responseId => ({ kind: 'tool_continue', response: responseId }),
      async beforeToolContinuation() {
        toolContinuationStarted.resolve();
        await releaseNativePlayback.promise;
        sentControls.push({ kind: 'native_playback_drained' });
      },
      encodeContextUpdate: text => [{ kind: 'context', text }],
      encodeTextTurn: (text): readonly VoiceRealtimeJsonValue[] => [{ kind: 'input_text', text }, { kind: 'response' }],
      async forgetProviderConversation() { nativeProviderConversationId = null; },
    };
    try {
      scope = createExternalVoiceProviderActivationScope({
        pluginId, occurrenceId: 'media-factory-occurrence', declarations: [declaration, ...preflightDeclarations], hostPlatform: 'web',
        runtimeHost: { ...hostLease.host,
          createConversationController(input) {
            const controller = hostLease.host.createConversationController(input);
            observedControllers.push({ deps: input, controller });
            return controller;
          },
        },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
      });
      scope.api.voiceProviders.register(localId, provider);
      for (const policyDeclaration of preflightDeclarations) scope.api.voiceProviders.register(policyDeclaration.id, provider);
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter) throw new Error('Public media factory provider was not registered');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { [providerId]: { schemaVersion: 1, config: {} } } });
      const selectedController = observedControllers.find(({ deps }) => deps.isSelectionCurrent());
      if (!selectedController) throw new Error('Expected the selected public provider controller');
      observation.deps = selectedController.deps;
      observation.controller = selectedController.controller;
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null, initialContext: 'startup context' });
      expect(sentControls).toEqual([{ kind: 'context', text: 'startup context' }]);
      const initialInput = constructionInputs[0]!;
      initialInput.levels.onOutputLevel(0.6);
      expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBeGreaterThan(0);
      expect(() => initialInput.media.createSdkHandleConnection({ driver })).toThrow('voice_media_factory_expired');
      expect(constructionInputs).toHaveLength(1);
      const deps = observation.deps;
      const controller = observation.controller;
      if (!deps || !controller) throw new Error('Missing observed real controller');
      const cancelled = new AbortController();
      cancelled.abort();
      // This is the actual captured owner's constructor callback, observed
      // without changing its controller or supplying an invented attempt.
      await expect(deps.createConnection({ config: null, safeMetadata: null }, controller.getOwnedAttemptId()!, cancelled.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(constructionInputs).toHaveLength(1);
      if (!adapter.retry) throw new Error('Expected the public reconnect entrypoint');
      await adapter.retry({ sessionId: 'stale-control-session', requestedTargetSessionAddress: null });
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(constructionInputs).toHaveLength(2);
      const replacementInput = constructionInputs[1]!;
      const replacementSnapshot = voiceRuntimeLevelStore.getSnapshot();
      initialInput.levels.onOutputLevel(0.2);
      expect(voiceRuntimeLevelStore.getSnapshot()).toBe(replacementSnapshot);
      replacementInput.levels.onOutputLevel(0.8);
      expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBeGreaterThan(0);
      sdkCallbacks.at(-1)!.onControl({ type: 'output_stopped' });
      await waitForTestEvent(notify => voiceRuntimeLevelStore.subscribe('output', notify), () => voiceRuntimeLevelStore.getSnapshot().outputLevel, level => level === 0);
      expect(voiceRuntimeLevelStore.getSnapshot().outputLevel).toBe(0);
      sentControls.length = 0;
      sdkCallbacks.at(-1)!.onControl({ type: 'tool_call', response: 'native-response', call: 'native-call',
        tool: 'listSessions', arguments: {} });
      await toolContinuationStarted.promise;
      expect(sentControls).toHaveLength(1);
      const nativeResult = sentControls[0];
      if (!nativeResult || !isControlRecord(nativeResult)
        || typeof nativeResult.result !== 'string') throw new Error('Expected native SDK tool result');
      expect(VoiceRealtimeToolResultV1Schema.parse(JSON.parse(nativeResult.result))).toMatchObject({
        responseId: 'native-response', callId: 'native-call', status: 'success',
      });
      releaseNativePlayback.resolve();
      await waitForTestEvent(subscribeControlSends, () => sentControls, events => events.some(event => isControlRecord(event) && event.kind === 'tool_continue'));
      expect(sentControls.slice(1)).toEqual([
        { kind: 'native_playback_drained' }, { kind: 'tool_continue', response: 'native-response' },
      ]);
      sentControls.length = 0;
      adapter.sendContextUpdate({ sessionId: controlSessionId, update: 'later context' });
      await waitForTestEvent(subscribeControlSends, () => sentControls.length, count => count > 0);
      expect(sentControls).toEqual([{ kind: 'context', text: 'later context' }]);
      sentControls.length = 0;
      const contextChannel = adapter.resolveContextChannel?.(storage.getState().settings);
      if (!contextChannel) throw new Error('Expected the connected public provider context channel');
      expect(contextChannel.hostAuthoredContext).toBe('session_context');
      const hiddenBriefContext = 'INBOX BRIEF\n{"items":[{"summary":"A session needs attention"}]}';
      contextChannel.sendTextMessage('Brief me', hiddenBriefContext);
      await waitForTestEvent(subscribeControlSends, () => sentControls,
        events => events.some(event => isControlRecord(event) && event.kind === 'response'));
      expect(sentControls).toEqual([
        { kind: 'context', text: hiddenBriefContext },
        { kind: 'input_text', text: 'Brief me' },
        { kind: 'response' },
      ]);
      sentControls.length = 0;
      contextChannel.sendTextMessage('An ordinary typed message');
      await waitForTestEvent(subscribeControlSends, () => sentControls,
        events => events.some(event => isControlRecord(event) && event.kind === 'response'));
      expect(sentControls).toEqual([
        { kind: 'input_text', text: 'An ordinary typed message' },
        { kind: 'response' },
      ]);
      sentControls.length = 0;
      const acknowledgeTranscript = environment.transcriptRequest.getMockImplementation();
      if (!acknowledgeTranscript) throw new Error('Expected the canonical transcript HTTP boundary');
      environment.transcriptRequest.mockImplementation(async (input, init) => {
        const response = await acknowledgeTranscript(input, init);
        previousTranscriptStarted.resolve();
        await releasePreviousTranscript.promise;
        return response;
      });
      sdkCallbacks.at(-1)!.onControl({ type: 'final', id: 'before-typed-final', item: 'before-typed-final', text: 'Settled before typed acceptance' });
      await previousTranscriptStarted.promise;
      let firstAccepted = false;
      const firstTurn = adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'first overlapping turn' })({ localId: 'public-first-turn', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {
          firstAccepted = true;
          acceptanceStarted.resolve();
          await releaseAcceptance.promise;
          sentControls.push({ kind: 'pending_settled', localId: 'public-first-turn' });
        } });
      await waitForTestEvent(subscribeControlSends, () => sentControls.length, count => count > 0);
      expect(sentControls).toEqual([{ kind: 'input_text', text: 'first overlapping turn' }]);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(firstAccepted).toBe(false);
      releasePreviousTranscript.resolve();
      await acceptanceStarted.promise;
      const secondTurn = adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'second overlapping turn' })({ localId: 'public-second-turn', deliveryCommand: 'interrupt_and_send', onAccepted: async () => { sentControls.push({ kind: 'pending_settled', localId: 'public-second-turn' }); } });
      await Promise.resolve();
      expect(sentControls).toEqual([{ kind: 'input_text', text: 'first overlapping turn' }]);
      releaseAcceptance.resolve();
      await Promise.all([firstTurn, secondTurn]);
      expect(sentControls).toEqual([
        { kind: 'input_text', text: 'first overlapping turn' },
        { kind: 'pending_settled', localId: 'public-first-turn' }, { kind: 'response' },
        { kind: 'input_text', text: 'second overlapping turn' },
        { kind: 'pending_settled', localId: 'public-second-turn' }, { kind: 'response' },
      ]);
      expect(readStoredSessionMessages(storage.getState(), environment.historySessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'user-text', text: 'Settled before typed acceptance' }),
        ]),
      );
      sentControls.length = 0;
      const acceptedBeforeStop = vi.fn(async () => {
        stoppedAcceptanceStarted.resolve();
        await releaseStoppedAcceptance.promise;
      });
      const admittedTurn = adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'accepted before Stop' })({ localId: 'public-admitted-stop', deliveryCommand: 'interrupt_and_send', onAccepted: acceptedBeforeStop });
      await stoppedAcceptanceStarted.promise;
      const queuedTurn = adapter.prepareTextTurn!({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'must not revive after Stop' })({ localId: 'public-queued-stop', deliveryCommand: 'interrupt_and_send', onAccepted: async () => { sentControls.push({ kind: 'stale_pending_settled' }); } });
      // Attach rejection observation before Stop aborts the queued delivery.
      let queuedSettled = false;
      void queuedTurn.catch(() => { queuedSettled = true; });
      await adapter.stop({ sessionId: controlSessionId });
      await queuedTurn.catch(() => {});
      expect(queuedSettled).toBe(true);
      releaseStoppedAcceptance.resolve();
      await expect(admittedTurn).rejects.toThrow('voice_transcript_carrier_changed');
      await expect(queuedTurn).rejects.toThrow('voice_transcript_attempt_ownership_mismatch');
      expect(acceptedBeforeStop).toHaveBeenCalledOnce();
      expect(sentControls).toEqual([{ kind: 'input_text', text: 'accepted before Stop' }]);
      const closeCount = closedConnections.length;
      const constructionCount = constructionInputs.length;
      failConstruction = true;
      const constructionError = await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null })
        .then(() => null, (error: unknown) => error);
      expect(constructionError).toMatchObject({ code: 'provider_connection_creation_failed' });
      expect(constructionInputs).toHaveLength(constructionCount + 1);
      expect(closedConnections.slice(closeCount)).toEqual([
        { code: 'error', detail: 'voice_connection_creation_failed' },
      ]);
      expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({ outputLevel: 0, outputSourceActive: false });
      failConstruction = false;
      for (const failure of [
        { code: 'credential_unavailable', kind: 'provider_auth_invalid' },
        { code: 'credential_access_review_required', kind: 'provider_auth_invalid' },
        { code: 'realtime_byo_not_configured', kind: 'provider_setup_required' },
        { code: 'realtime_agent_update_required', kind: 'provider_setup_required' },
      ]) {
        prepareFailure = failure.code;
        await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null })).resolves.toBeUndefined();
        expect(adapter.getSnapshot()).toMatchObject({ errorCode: failure.kind });
        prepareFailure = null;
        sdkOpenFailure = failure.code;
        await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null }))
          .rejects.toMatchObject({ code: failure.code });
        expect(adapter.getSnapshot()).toMatchObject({ errorCode: failure.kind });
        sdkOpenFailure = null;
      }
      prepareDecline = 'agent_signed_out';
      await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null })).resolves.toBeUndefined();
      expect(adapter.getSnapshot()).toMatchObject({ errorCode: 'authentication_required', errorRecoveryAction: 'connect_agent' });
      prepareDecline = null;
      for (const code of ['agent_signed_out', 'execution_machine_unavailable', 'update_required']) {
        sdkOpenFailure = code;
        await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null }))
          .rejects.toMatchObject({ code });
        expect(adapter.getSnapshot()).toMatchObject({ errorCode: code === 'agent_signed_out' ? 'authentication_required' : code });
      }
      sdkOpenFailure = 'provider_specific_failure';
      log.clear();
      await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null }))
        .rejects.toMatchObject({ code: 'provider_specific_failure' });
      expect(adapter.getSnapshot()).toMatchObject({ errorCode: 'provider_error' });
      expect(log.getLogs().filter(line => line.includes('[voiceRuntimeFailure]'))).toEqual([
        expect.stringContaining('provider_specific_failure'),
      ]);
      sdkOpenFailure = 'machine unavailable at /Users/private/repository';
      log.clear();
      await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null }))
        .rejects.toMatchObject({ message: 'voice_connection_failed', code: 'voice_connection_failed' });
      const failures = log.getLogs().filter(line => line.includes('[voiceRuntimeFailure]'));
      expect(failures).toEqual([expect.stringContaining('voice_connection_failed')]);
      expect(failures.join('\n')).not.toContain('/Users/private/repository');
      sdkOpenFailure = null;
      preparedContextDelivery = true;
      publishProviderConversation = true;
      sentControls.length = 0;
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null, initialContext: 'prepared startup context' });
      expect(constructionInputs.at(-1)!.session).toMatchObject({
        config: { initialContext: 'prepared startup context' }, initialContextDelivery: 'prepared',
      });
      // This public preparation already carries startup context; the real
      // connection must not receive a duplicate host-authored context update.
      expect(sentControls).toEqual([]);
      adapter.sendContextUpdate({ sessionId: controlSessionId, update: 'context after prepared startup' });
      await waitForTestEvent(subscribeControlSends, () => sentControls.length, count => count > 0);
      expect(sentControls).toEqual([{ kind: 'context', text: 'context after prepared startup' }]);
      const readProviderConversationState = hostLease.host.readProviderConversationState;
      if (!readProviderConversationState) throw new Error('Expected the real provider conversation persistence reader');
      const persistedConversation = { providerId, conversationSessionId: environment.historySessionId };
      expect(nativeProviderConversationId).toBe('sdk-native-conversation');
      expect(await readProviderConversationState(persistedConversation)).toMatchObject({ conversationId: 'sdk-native-conversation' });
      await expect(adapter.performRuntimeAction?.('forget_provider_conversation')).resolves.toEqual({ status: 'completed' });
      expect(nativeProviderConversationId).toBeNull();
      expect(await readProviderConversationState(persistedConversation)).toBeNull();
      await expect(adapter.performRuntimeAction?.('unknown')).resolves.toEqual({ status: 'unsupported' });
      expect(deps.isSelectionCurrent(), JSON.stringify({
        selected: storage.getState().settings.voice.providerId,
        canonicalSelected: storage.getState().settings.voiceSettingsV1.providerId,
        persistedSelected: environment.persistedAccountSettings.voice.providerId,
        projectedSelected: hostLease.host.projectVoiceSettings(hostLease.host.getSettings(), providerId)?.providerId,
      })).toBe(true);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { [providerId]: { schemaVersion: 1, config: { authentication: { source: 'connected_service_api_key' } } } } });
      expect(deps.isSelectionCurrent()).toBe(true);
      await adapter.stop({ sessionId: controlSessionId });
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId: null });
      expect(deps.isSelectionCurrent()).toBe(false);
      log.clear();
      await expect(adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null })).resolves.toBeUndefined();
      expect(log.getLogs().filter(line => line.includes('[voiceRuntimeFailure]'))).toEqual([
        expect.stringContaining('voice_provider_not_selected'),
      ]);
      preparedContextDelivery = false;
      publishProviderConversation = false;
      const unavailableIntl = Object.create(Intl);
      Object.defineProperty(unavailableIntl, 'Segmenter', { value: undefined });
      vi.stubGlobal('Intl', unavailableIntl);
      try {
        for (const policy of ['provider_immediate', 'client_two_stage'] as const) {
          const policyProviderId = `${pluginId}/${policy.replaceAll('_', '-')}`;
          const policyAdapter = getExternalVoiceProviderRegistration(policyProviderId)?.adapter;
          if (!policyAdapter) throw new Error('Expected the registered public policy provider');
          registerVoiceAdapters([policyAdapter]);
          await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId: policyProviderId,
            providers: { [policyProviderId]: { schemaVersion: 1, config: {} } } });
          await policyAdapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null,
            textOnly: policy === 'client_two_stage' });
          expect(policyAdapter.getSnapshot().status).toBe('connected');
          await policyAdapter.stop({ sessionId: controlSessionId });
          if (policy === 'client_two_stage') {
            const constructionsBeforeRefusal = constructionInputs.length;
            await expect(policyAdapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null }))
              .rejects.toMatchObject({ code: 'provider_setup_required' });
            expect(policyAdapter.getSnapshot().errorCode).toBe('provider_setup_required');
            expect(constructionInputs).toHaveLength(constructionsBeforeRefusal);
          }
        }
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      releaseAcceptance.resolve();
      releaseStoppedAcceptance.resolve();
      releaseNativePlayback.resolve();
      releasePreviousTranscript.resolve();
      await scope?.unwind();
      hostLease.revoke();
      await environment.dispose();
    }
  });

  it('admits typed delivery through real public SDK custody and refuses a rejected native send before acceptance', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.typed-custody';
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: 'sdk', title: 'Typed custody SDK', kind: 'conversation', platforms: ['web'],
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'typed-custody-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected the public conversation declaration');
    const providerId = `${pluginId}/${declaration.id}`;
    const scope = createExternalVoiceProviderActivationScope({ pluginId, occurrenceId: 'typed-custody-occurrence',
      declarations: [declaration], hostPlatform: 'web', runtimeHost: hostLease.host,
      isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host });
    const controls: VoiceRealtimeJsonValue[] = [];
    let rejectNativeSend = false;
    scope.api.voiceProviders.register(declaration.id, {
      kind: 'conversation', microphoneMode: 'provider_managed', setInputMuted() {},
      protocol: {
        async prepare({ signal }) { return signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } }; },
        decodeControl: () => [], encodeTurnControl: () => null,
      },
      async createConnection({ media }) {
        return media.createSdkHandleConnection({ driver: { async open() {}, async close() {},
          async sendControl(event) {
            if (rejectNativeSend) throw new Error('private native transcript at /Users/private');
            controls.push(event);
          },
        } });
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ kind: 'unused' }),
      encodeContextUpdate: () => [],
      encodeTextTurn: (text): readonly VoiceRealtimeJsonValue[] => [{ kind: 'input_text', text }, { kind: 'response' }],
    });
    try {
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter?.prepareTextTurn) throw new Error('Expected the registered typed-delivery owner');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { [providerId]: { schemaVersion: 1, config: {} } } });
      const controlSessionId = hostLease.host.globalVoiceSessionId;
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null, initialContext: '' });
      await adapter.prepareTextTurn({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'supported input' })({ localId: 'typed-supported', deliveryCommand: 'interrupt_and_send', onAccepted: async () => { controls.push({ kind: 'pending_settled' }); } });
      expect(controls).toEqual([{ kind: 'input_text', text: 'supported input' }, { kind: 'pending_settled' }, { kind: 'response' }]);
      const accepted = vi.fn(async () => {});
      rejectNativeSend = true;
      await expect(adapter.prepareTextTurn({ controlSessionId, conversationSessionId: environment.historySessionId, text: 'must not be accepted' })({ localId: 'typed-rejected', deliveryCommand: 'interrupt_and_send', onAccepted: accepted })).rejects.toMatchObject({ message: 'voice_service_unavailable' });
      expect(accepted).not.toHaveBeenCalled();
      expect(controls).toHaveLength(3);
    } finally { await scope.unwind(); hostLease.revoke(); await environment.dispose(); }
  });

  it('owns generic lifecycle/resources/tool barrier without provider-id policy branches', async () => {
    let controllerInput: VoiceConversationControllerDeps | null = null;
    let barrierInput: Parameters<BundledRealtimeProviderRuntimeHost['createToolBarrier']>[0] | null = null;
    const start = vi.fn(async (): Promise<VoiceConversationControllerStartResult> => ({ status: 'connected' }));
    const stop = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const interruptOrder: string[] = [];
    const performTurnControl = vi.fn(async (action: VoiceTurnControlAction) => {
      interruptOrder.push(action);
      return { status: 'sent' as const };
    });
    const sentEvents: unknown[] = [];
    const prepare = vi.fn(async () => {
      throw Object.assign(new Error('credential_unavailable'), {
        name: 'XaiRealtimeVoiceUiClientError',
        code: 'credential_unavailable',
      });
    });
    const sendClientControl = vi.fn<VoiceConversationController['sendClientControl']>(async (event) => {
      sentEvents.push(event);
      if ((event as { type?: unknown } | null)?.type === 'output_audio_buffer.clear') {
        interruptOrder.push('remote-output-cleared');
      }
      return { status: 'sent' as const };
    });
    const beginOutputInterruptionCandidate = vi.fn(() => 'retained' as const);
    const resolveOutputInterruptionCandidate = vi.fn();
    const requestReconnect = vi.fn(async () => true);
    const getActiveControlSessionId = vi.fn((): string | null => 'voice-global');
    const micStream = { getAudioTracks: () => [] } as unknown as MediaStream;
    const ensureMicActive = vi.fn<() => Promise<void>>(async () => undefined);
    const mic = {
      ensureActive: ensureMicActive, teardown: vi.fn(async () => undefined),
      setMuted: vi.fn(), isMuted: vi.fn(() => false),
      getStream: vi.fn(() => micStream),
      getAudioContext: vi.fn(() => null),
    };
    let emitMicLevel = (_level: number): void => {};
    let emitMicFailure = (_failure: Readonly<{ kind: VoiceMachineErrorKind; reason: string }>): void => {};
    const inputLevelWriter = { write: vi.fn(), reset: vi.fn(), close: vi.fn() };
    const outputLevelWriters: Array<{ write: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
    const openLevelWriter = vi.fn(({ channel }: Readonly<{ channel: 'input' | 'output' }>) => {
      if (channel === 'input') return inputLevelWriter;
      const writer = { write: vi.fn(), reset: vi.fn(), close: vi.fn() };
      outputLevelWriters.push(writer);
      return writer;
    });
    const closeWebRtcConnection = vi.fn(async () => undefined);
    const webRtcConnection = {
      state: () => 'open',
      close: closeWebRtcConnection,
    } as unknown as VoiceRealtimeConnection;
    const closePcmConnection = vi.fn(async () => undefined);
    const pcmConnection = {
      state: () => 'open',
      close: closePcmConnection,
    } as unknown as VoiceRealtimeConnection;
    const pcmMedia = {
      pcm: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
      enqueueOutput: vi.fn(() => true),
      clearOutput: vi.fn(),
      waitForOutputDrain: vi.fn(async () => undefined),
    };
    const createWebRtcConnection = vi.fn((
      _input: Parameters<BundledRealtimeProviderRuntimeHost['createWebRtcConnection']>[0],
    ) => webRtcConnection);
    const createSdkHandleConnection = vi.fn(() => webRtcConnection);
    const createWebSocketPcmMedia = vi.fn(() => pcmMedia);
    const createWebSocketPcmConnection = vi.fn(() => pcmConnection);
    const negotiatedWebRtc = Object.freeze({
      signaling: Object.freeze({
        exchangeOffer: vi.fn(async () => ({ answerSdp: 'v=0\r\n' })),
      }),
      control: Object.freeze({ label: 'events', onOpen: vi.fn() }),
    });
    let failAfterConnectionCreation = false;
    const createConnection = vi.fn(async (input: unknown) => {
      const media = (input as Readonly<{
        media: Readonly<{
          createWebRtcConnection(input: typeof negotiatedWebRtc): VoiceRealtimeConnection;
        }>;
      }>).media;
      const connection = media.createWebRtcConnection(negotiatedWebRtc);
      if (failAfterConnectionCreation) throw new Error('provider_connection_creation_failed');
      return connection;
    });
    const releaseAudioMode = vi.fn(async () => undefined);
    let interruptionPolicy: 'client_two_stage' | 'provider_immediate' = 'client_two_stage';
    let hostGenerationCurrent = true;
    const captureRetiringDirectMediaTranscriptDrain = vi.fn(() => (
      Object.freeze({}) as unknown as BundledRetiringDirectMediaTranscriptDrain
    ));
    let resolvedConversationSessionId: string | null = 'session-1';
    let directMediaAcquisitionCount = 0;
    const carrierRebindStarted = createDeferredVoid();
    const releaseCarrierRebind = createDeferredVoid();
    const releaseTranscriptPersistence = createDeferredVoid();
    const hostMedia = {
      createSdkHandleConnection,
      createWebRtcConnection,
      createWebSocketPcmMedia,
      createWebSocketPcmConnection,
    };
    const onConnected = vi.fn();
    const currentUiVoiceHooks = {
      onStarted: vi.fn(() => 'context'),
      onStopped: vi.fn(),
      onConnected,
    };
    const host = {
      globalVoiceSessionId: 'voice-global',
      isCurrentGeneration: () => hostGenerationCurrent,
      runCurrentGenerationEffect(callback: () => void): boolean {
        if (!hostGenerationCurrent) return false;
        callback();
        return true;
      },
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId: 'realtime_example' } }),
      projectVoiceSettings: () => ({ providerId: 'realtime_example', providerConfig: {} }),
      machine: {
        transitionToAcquiringMic: vi.fn(), transitionToConnecting: vi.fn(), transitionToConnected: vi.fn(),
        setReconnecting: vi.fn(),
        transitionToSpeaking: vi.fn(), transitionToEnding: vi.fn(), transitionToDisconnected: vi.fn(),
        setError: vi.fn(), setMuted: vi.fn(), getSnapshot: vi.fn(() => ({ status: 'disconnected' })),
        projectSnapshot: vi.fn(() => ({ adapterId: 'realtime_example', sessionId: null, status: 'disconnected' as const, mode: 'idle' as const, canStop: false })),
        subscribe: vi.fn(() => vi.fn()),
      },
      createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
        controllerInput = input;
        return {
          ...createVoiceConversationController(input),
          start,
          stop,
          fail,
          performTurnControl,
          sendClientControl,
          getActiveControlSessionId,
          canCommitInput: () => false,
          getOwnedControlSessionId: vi.fn(() => 'voice-global'),
          getOwnedAttemptId: vi.fn(() => 1),
          requestReconnect,
          playbackCursorMs: vi.fn(() => 0),
          beginOutputInterruptionCandidate,
          resolveOutputInterruptionCandidate,
        };
      }),
      createMicSession: vi.fn((options: Readonly<{
        onFailure(failure: Readonly<{ kind: VoiceMachineErrorKind; reason: string }>): void;
        onLevel(level: number): void;
      }>) => {
        emitMicLevel = (level) => options.onLevel?.(level);
        emitMicFailure = (failure) => options.onFailure(failure);
        return mic;
      }),
      openLevelWriter,
      ensureBound: vi.fn(async () => undefined),
      acquireDirectMediaConversation: vi.fn(async () => {
        directMediaAcquisitionCount += 1;
        if (directMediaAcquisitionCount > 1) {
          carrierRebindStarted.resolve();
          await releaseCarrierRebind.promise;
          resolvedConversationSessionId = 'session-2';
        }
        return {
          conversationSessionId: resolvedConversationSessionId ?? 'session-2',
        };
      }),
      releaseDirectMediaConversation: vi.fn(),
      captureRetiringDirectMediaTranscriptDrain,
      releaseRetiringDirectMediaTranscriptDrain: vi.fn(),
      resolveConversationSessionId: vi.fn(() => resolvedConversationSessionId),
      applyTargetSelection: vi.fn(),
      acquireAudioMode: vi.fn(async () => ({ release: releaseAudioMode })),
      projectTranscript: vi.fn(({ event }: Readonly<{ event: unknown }>) => {
        const transcript = event as Readonly<{ role?: unknown; type?: unknown; itemId?: unknown }>;
        return transcript.role === 'assistant'
          && transcript.type === 'voice.transcript.final'
          && transcript.itemId === 'assistant-1'
          ? 'persisted-assistant-1'
          : null;
      }),
      admitTranscriptPersistenceEvent: vi.fn(() => null),
      commitAdmittedTranscriptPersistenceEvent: vi.fn(() => null),
      releaseAdmittedTranscriptPersistenceEvent: vi.fn(() => false),
      settleTranscriptPersistence: vi.fn(async () => {
        await releaseTranscriptPersistence.promise;
      }),
      beginTranscriptAttempt: vi.fn(() => ({
        epoch: 1,
        attemptIdentity: 'attempt-1',
      })),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn((input: Parameters<BundledRealtimeProviderRuntimeHost['createToolBarrier']>[0]) => {
        barrierInput = input;
        return { run: vi.fn(async () => ({ status: 'submitted' as const, results: [] })), cancel: vi.fn(() => false), dispose: vi.fn() };
      }),
      voiceHooks: currentUiVoiceHooks,
      createMachineError: vi.fn((input) => ({
        ...input,
        phase: 'runtime' as const,
        retryPolicy: 'user_action' as const,
        recoveryAction: 'retry' as const,
        presentation: 'error' as const,
        recoverable: true,
      })),
      ...hostMedia,
    } satisfies BundledRealtimeProviderRuntimeHost & typeof hostMedia;
    const runtime = createBundledRealtimeProviderRuntime(host, {
      providerId: 'realtime_example',
      providerSource: {
        pluginId: 'happier.voice.test',
        contributionId: 'realtime-example',
      },
      execution: { kind: 'direct_media' },
      protocol: {
        id: 'realtime_example',
        turnControls: {
          cancelResponse: 'immediate' as const,
          truncatePlayback: 'unsupported' as const,
          clearInput: true,
          stopSession: true,
          resumption: 'none' as const,
          exactMessage: true,
        },
        prepare, decodeControl: vi.fn(), encodeTurnControl: vi.fn(),
      },
      microphoneMode: 'host_webrtc',
      createConnection,
      outputLevelMeter: 'measured',
      encodeToolResults: vi.fn(() => [{ type: 'tool.output' }]), encodeToolContinuation: vi.fn(() => ({ type: 'response.create' })),
      beforeToolContinuation: vi.fn(async () => { sentEvents.push('playback-drained'); }),
      beforeInterrupt: vi.fn(async () => { interruptOrder.push('local-output-cleared'); }),
      encodePostCancelControls: vi.fn(() => [{ type: 'output_audio_buffer.clear' }]),
      runtimeActions: {
        forget_provider_conversation: vi.fn(async () => { sentEvents.push('forgot-provider-conversation'); }),
      },
      encodeContextUpdate: vi.fn((text: string) => [{ type: 'session.update', text }]),
      encodeTextTurn: vi.fn((text: string) => [
        { type: 'conversation.item.create', text } as VoiceRealtimeJsonValue,
        { type: 'response.create' } as VoiceRealtimeJsonValue,
      ]),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true,
        controlSessionScope: 'global',
        requiresVoiceAgentFeature: false,
        bargeInEnabled: true,
        interruptionPolicy,
        agentRuntime: {
          pluginId: 'spoofed.agent',
          localId: 'spoofed-agent',
        },
      }),
    });
    expect(runtime.adapter.resolveSurfaceCapabilities?.({})).toMatchObject({
      cancelResponse: 'immediate',
    });
    expect(runtime.adapter.resolveSurfaceCapabilities?.({})).not.toHaveProperty('agentRuntime');
    await runtime.adapter.start({
      sessionId: 'session-1',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-1' },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ controlSessionId: 'session-1' }));
    if (!runtime.adapter.retry) throw new Error('realtime retry route unavailable');
    await runtime.adapter.retry({
      sessionId: 'stale-session-id',
      requestedTargetSessionAddress: null,
    });
    expect(requestReconnect).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(host.voiceHooks.onStarted).toHaveBeenCalledWith('session-1', 'session_context');
    expect(onConnected).toHaveBeenCalledWith('session-1');
    expect(openLevelWriter).toHaveBeenCalledWith({ channel: 'input', sourceId: 'realtime_example:session-1' });
    expect(openLevelWriter).not.toHaveBeenCalledWith({ channel: 'output', sourceId: expect.any(String) });
    emitMicLevel(0.5);
    expect(inputLevelWriter.write).toHaveBeenCalledWith(0.5);
    expect(controllerInput).toMatchObject({
      createToolBarrier: expect.any(Function),
      resources: expect.any(Object),
      onConnectionReady: expect.any(Function),
    });
    const runtimeEvents = controllerInput as unknown as Readonly<{
      onCanonicalEvent(
        event: Parameters<VoiceConversationControllerDeps['onCanonicalEvent']>[0],
      ): Promise<void>;
      projectTranscript(input: Readonly<{
        controlSessionId: string;
        attemptId: number;
        connectionId: number;
        event: unknown;
      }>): void;
    }>;
    const createControllerConnection = (controllerInput as unknown as Readonly<{
      createConnection(session: unknown, attemptId: number, signal: AbortSignal): Promise<unknown>;
    }>).createConnection;
    await createControllerConnection({
      config: null,
      safeMetadata: {
        billingMode: 'happier',
        expiresAtMs: Date.now() + 30,
      },
    }, 7, new AbortController().signal);
    (controllerInput as unknown as VoiceConversationControllerDeps).machine.connected({
      controlSessionId: 'voice-global',
      attemptId: 7,
    });
    expect(host.presentHostedLeaseNotice).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'voice-global',
      providerId: 'realtime_example',
      phase: 'started',
    }));
    expect(host.presentHostedLeaseNotice).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'expiring',
    }));
    await vi.waitFor(() => expect(host.presentHostedLeaseNotice).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'expired' }),
    ));
    expect(createWebRtcConnection).toHaveBeenCalledTimes(1);
    expect(createWebRtcConnection.mock.calls[0]![0]).toMatchObject({
      ...negotiatedWebRtc,
      micStream: mic.getStream(),
      duckGain: 0.18,
    });
    expect(createWebSocketPcmMedia).not.toHaveBeenCalled();
    expect(openLevelWriter).toHaveBeenCalledWith({ channel: 'output', sourceId: 'realtime_example:session-1:attempt-7' });
    const attemptOneWriter = outputLevelWriters[0]!;
    const connectionInput = createConnection.mock.calls[0]![0] as Readonly<{
      levels: Readonly<{ onOutputLevel(level: number): void }>;
    }>;
    connectionInput.levels.onOutputLevel(0.6);
    expect(attemptOneWriter.write).toHaveBeenCalledWith(0.6);
    await createControllerConnection({ config: null, safeMetadata: null }, 8, new AbortController().signal);
    expect(createWebSocketPcmMedia).not.toHaveBeenCalled();
    expect(createWebSocketPcmConnection).not.toHaveBeenCalled();
    expect(attemptOneWriter.close).toHaveBeenCalledTimes(1);
    const attemptTwoWriter = outputLevelWriters[1]!;
    const secondConnectionInput = createConnection.mock.calls[1]![0] as Readonly<{
      levels: Readonly<{ onOutputLevel(level: number): void }>;
      media: Readonly<{
        createWebRtcConnection(input: typeof negotiatedWebRtc): VoiceRealtimeConnection;
      }>;
    }>;
    connectionInput.levels.onOutputLevel(0.2);
    secondConnectionInput.levels.onOutputLevel(0.8);
    expect(attemptOneWriter.write).not.toHaveBeenCalledWith(0.2);
    expect(attemptTwoWriter.write).toHaveBeenCalledWith(0.8);
    expect(() => secondConnectionInput.media.createWebRtcConnection(negotiatedWebRtc))
      .toThrow('voice_media_factory_expired');
    expect(createWebRtcConnection).toHaveBeenCalledTimes(2);
    const cancelledAttempt = new AbortController();
    cancelledAttempt.abort();
    await expect(createControllerConnection(
      { config: null, safeMetadata: null },
      9,
      cancelledAttempt.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(createConnection).toHaveBeenCalledTimes(2);
    await runtimeEvents.onCanonicalEvent({ type: 'assistant_output_started', itemId: 'assistant-1' });
    // Generation replacement revokes A's live provider authority before A's
    // asynchronous disposal completes. A queued provider event must not enter
    // its barge-in coordinator and create an interruption candidate.
    beginOutputInterruptionCandidate.mockClear();
    hostGenerationCurrent = false;
    await runtimeEvents.onCanonicalEvent({ type: 'input_speech_started' });
    expect(beginOutputInterruptionCandidate).not.toHaveBeenCalled();
    hostGenerationCurrent = true;
    // Segmentation admission is covered through the registered public policy
    // providers above. This legacy resource oracle drives each preflight once,
    // as the real controller does, rather than re-admitting a live carrier.
    const onConnectionReady = (controllerInput as unknown as Readonly<{
      onConnectionReady(input: Readonly<{
        request: VoiceRealtimeJsonValue;
        session: Readonly<{ config: VoiceRealtimeJsonValue; safeMetadata: VoiceRealtimeJsonValue; initialContextDelivery?: 'prepared' }>;
        connection: Readonly<{ sendControl(event: VoiceRealtimeJsonValue): Promise<void> }>;
        signal: AbortSignal;
      }>): Promise<void>;
    }>).onConnectionReady;
    sentEvents.length = 0;
    await onConnectionReady({
      request: { initialContext: 'context' },
      session: { config: {}, safeMetadata: null },
      connection: { sendControl: async (event) => { sentEvents.push(event); } },
      signal: new AbortController().signal,
    });
    expect(sentEvents).toEqual([{ type: 'session.update', text: 'context' }]);
    sentEvents.length = 0;
    await onConnectionReady({
      request: { initialContext: 'context' },
      session: { config: {}, safeMetadata: null, initialContextDelivery: 'prepared' },
      connection: { sendControl: async (event) => { sentEvents.push(event); } },
      signal: new AbortController().signal,
    });
    expect(sentEvents).toEqual([]);
    runtime.adapter.sendContextUpdate({ sessionId: 'session-1', update: 'later context' });
    await vi.waitFor(() => expect(sentEvents).toEqual([{ type: 'session.update', text: 'later context' }]));
    sentEvents.length = 0;
    const startupProtocol = controllerInput as unknown as Readonly<{
      adapter: Readonly<{ prepare(input: unknown): Promise<unknown> }>;
    }>;
    prepare.mockRejectedValueOnce(Object.assign(new Error('agent config is stale'), {
      code: 'realtime_agent_update_required',
    }));
    await expect(startupProtocol.adapter.prepare({})).resolves.toEqual({
      kind: 'declined', code: 'realtime_agent_update_required',
    });
    await controllerInput!.resources!.preflight!({
      controlSessionId: 'session-1',
      attemptId: 1,
      request: { textOnly: true },
      signal: new AbortController().signal,
    });
    await controllerInput!.resources!.prepare({
      controlSessionId: 'session-1',
      attemptId: 1,
      request: { textOnly: true },
      signal: new AbortController().signal,
    });
    expect(host.beginTranscriptAttempt).toHaveBeenCalledWith({ conversationSessionId: 'session-1' });
    resolvedConversationSessionId = null;
    log.clear();
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 1,
      event: {
        v: 1,
        epoch: 7,
        sequence: 7,
        revision: 1,
        eventId: 'assistant-1:delta',
        role: 'assistant',
        type: 'voice.transcript.delta',
        text: 'the current',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    });
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 1,
      event: {
        v: 1,
        epoch: 7,
        sequence: 8,
        revision: 2,
        eventId: 'assistant-1:updated',
        role: 'assistant',
        type: 'voice.transcript.updated',
        text: 'the current response',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    });
    expect(host.acquireDirectMediaConversation).toHaveBeenCalledTimes(1);
    expect(host.beginTranscriptAttempt).toHaveBeenCalledTimes(1);
    expect(host.projectTranscript).not.toHaveBeenCalled();
    expect(log.getLogs()).toEqual([]);
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 1,
      event: {
        v: 1,
        epoch: 7,
        sequence: 9,
        revision: 1,
        eventId: 'assistant-1:final',
        role: 'assistant',
        type: 'voice.transcript.final',
        text: 'the current response',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    });
    await carrierRebindStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 900));
    await runtimeEvents.onCanonicalEvent({ type: 'input_speech_started' });
    expect(host.machine.transitionToSpeaking).toHaveBeenCalledWith('voice-global', 'realtime_example');
    expect(beginOutputInterruptionCandidate).toHaveBeenCalledTimes(1);
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 2,
      event: {
        v: 1,
        epoch: 7,
        sequence: 1,
        revision: 1,
        eventId: 'user-1:final',
        role: 'user',
        type: 'voice.transcript.final',
        text: 'please stop and answer this question',
        itemId: 'user-1',
        provenance: 'live',
      },
    });
    await vi.waitFor(() => expect(
      resolveOutputInterruptionCandidate,
    ).toHaveBeenCalledWith('confirmed'));
    releaseCarrierRebind.resolve();
    await vi.waitFor(() => expect(host.projectTranscript).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'session-2',
      retiringTranscriptDrain: expect.any(Object),
      source: {
        pluginId: 'happier.voice.test',
        contributionId: 'realtime-example',
      },
      event: {
        v: 1,
        epoch: 1,
        sequence: 3,
        revision: 1,
        eventId: 'assistant-1:final',
        role: 'assistant',
        type: 'voice.transcript.final',
        text: 'the current response',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    }));
    expect(host.projectTranscript).toHaveBeenNthCalledWith(2, {
      conversationSessionId: 'session-2',
      retiringTranscriptDrain: expect.any(Object),
      source: {
        pluginId: 'happier.voice.test',
        contributionId: 'realtime-example',
      },
      event: {
        v: 1,
        epoch: 1,
        sequence: 4,
        revision: 1,
        eventId: 'user-1:final',
        role: 'user',
        type: 'voice.transcript.final',
        text: 'please stop and answer this question',
        itemId: 'user-1',
        provenance: 'live',
      },
    });
    await vi.waitFor(() => expect(resolveOutputInterruptionCandidate).toHaveBeenCalledWith('confirmed'));
    releaseTranscriptPersistence.resolve();
    expect(captureRetiringDirectMediaTranscriptDrain).toHaveBeenCalledTimes(1);
    resolvedConversationSessionId = null;
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 1,
      event: {
        v: 1,
        epoch: 7,
        sequence: 10,
        revision: 2,
        eventId: 'assistant-1:corrected',
        role: 'assistant',
        type: 'voice.transcript.corrected',
        text: 'the corrected response',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    });
    await Promise.resolve();
    expect(host.acquireDirectMediaConversation).toHaveBeenCalledTimes(2);
    expect(host.projectTranscript).toHaveBeenCalledTimes(2);
    runtimeEvents.projectTranscript({
      controlSessionId: 'session-1',
      attemptId: 1,
      connectionId: 1,
      event: {
        v: 1,
        epoch: 7,
        sequence: 11,
        revision: 1,
        eventId: 'assistant-2:final',
        role: 'assistant',
        type: 'voice.transcript.final',
        text: 'the next authoritative response',
        itemId: 'assistant-2',
        provenance: 'live',
      },
    });
    await vi.waitFor(() => {
      expect(host.acquireDirectMediaConversation).toHaveBeenCalledTimes(3);
      expect(host.projectTranscript).toHaveBeenNthCalledWith(3, expect.objectContaining({
        conversationSessionId: 'session-2',
        event: expect.objectContaining({
          type: 'voice.transcript.final',
          text: 'the next authoritative response',
        }),
      }));
    });
    resolvedConversationSessionId = 'session-1';
    expect(interruptOrder).toEqual([
      'local-output-cleared',
      'cancel_response',
      'remote-output-cleared',
    ]);
    interruptOrder.length = 0;
    sentEvents.length = 0;
    await runtimeEvents.onCanonicalEvent({ type: 'assistant_output_stopped' });
    expect(attemptTwoWriter.reset).toHaveBeenCalledTimes(1);
    closeWebRtcConnection.mockClear();
    failAfterConnectionCreation = true;
    await expect(createControllerConnection(
      { config: null, safeMetadata: null },
      10,
      new AbortController().signal,
    )).rejects.toThrow('provider_connection_creation_failed');
    expect(closeWebRtcConnection).toHaveBeenCalledWith({
      code: 'error',
      detail: 'voice_connection_creation_failed',
    });
    expect(resolveOutputInterruptionCandidate).toHaveBeenCalledWith('confirmed');
    expect(performTurnControl).toHaveBeenCalledWith('cancel_response');
    interruptionPolicy = 'provider_immediate';
    await runtimeEvents.onCanonicalEvent({ type: 'assistant_output_started' });
    await runtimeEvents.onCanonicalEvent({ type: 'input_speech_started' });
    expect(beginOutputInterruptionCandidate).toHaveBeenCalledTimes(1);
    const controllerProtocol = (controllerInput as unknown as Readonly<{
      adapter: Readonly<{ prepare(input: unknown): Promise<unknown> }>;
      machine: Readonly<{
        connected(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
        reconnecting(input: Readonly<{
          controlSessionId: string;
          attemptId?: number;
          active: boolean;
          retryAvailable?: boolean;
        }>): void;
        disconnected(input: Readonly<{ controlSessionId: string; code?: string }>): void;
        failed(input: Readonly<{ controlSessionId: string; code: string }>): void;
      }>;
    }>);
    await expect(controllerProtocol.adapter.prepare({})).resolves.toEqual({
      kind: 'declined',
      code: 'credential_unavailable',
    });
    prepare.mockRejectedValueOnce(Object.assign(
      new Error('recipient contract changed; private details omitted'),
      { code: 'credential_access_review_required' },
    ));
    await expect(controllerProtocol.adapter.prepare({})).resolves.toEqual({
      kind: 'declined',
      code: 'credential_access_review_required',
    });
    prepare.mockRejectedValueOnce(Object.assign(new Error('rate_limited'), { code: 'rate_limited' }));
    await expect(controllerProtocol.adapter.prepare({})).rejects.toThrow('rate_limited');
    controllerProtocol.machine.reconnecting({
      controlSessionId: 'voice-global',
      attemptId: 1,
      active: true,
      retryAvailable: true,
    });
    expect(host.machine.setReconnecting).toHaveBeenCalledWith(
      'voice-global',
      'realtime_example',
      true,
      1,
      true,
    );
    controllerProtocol.machine.connected({ controlSessionId: 'voice-global', attemptId: 1 });
    controllerProtocol.machine.disconnected({ controlSessionId: 'voice-global', code: 'credential_unavailable' });
    expect(inputLevelWriter.close).toHaveBeenCalledTimes(1);
    expect(attemptTwoWriter.close).toHaveBeenCalledTimes(1);
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_unavailable',
    });
    controllerProtocol.machine.disconnected({
      controlSessionId: 'voice-global',
      code: 'execution_machine_unavailable',
    });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'execution_machine_unavailable',
      reason: 'execution_machine_unavailable',
    });
    controllerProtocol.machine.disconnected({
      controlSessionId: 'voice-global',
      code: 'credential_access_review_required',
    });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_access_review_required',
    });
    controllerProtocol.machine.disconnected({
      controlSessionId: 'voice-global',
      code: 'realtime_byo_not_configured',
    });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_setup_required',
      reason: 'realtime_byo_not_configured',
    });
    controllerProtocol.machine.disconnected({
      controlSessionId: 'voice-global', code: 'realtime_agent_update_required',
    });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_setup_required', reason: 'realtime_agent_update_required',
    });
    emitMicFailure({ kind: 'mic_permission_revoked', reason: 'browser_permission_revoked' });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('mic_permission_revoked'));
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'mic_permission_revoked' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'mic_permission_revoked',
      reason: 'mic_permission_revoked',
    });
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'mic_ended' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'mic_ended',
      reason: 'mic_ended',
    });
    log.clear();
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'provider_specific_failure' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_error',
      reason: 'provider_specific_failure',
    });
    // Flattening an unknown code into `provider_error` renders as the single
    // generic "Connection Error"; the typed reason must survive in the log.
    const flattenedLog = String(log.getLogs().at(-1));
    expect(flattenedLog).toContain('provider_specific_failure');
    expect(flattenedLog).toContain('realtime_example');
    // One credential fact, one kind: a credential code that arrives as a thrown
    // failure must classify exactly as the same code arriving as a decline, or
    // the surface offers a "Retry" that can never succeed instead of "Review
    // credentials".
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'credential_unavailable' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_unavailable',
    });
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'realtime_byo_not_configured' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_setup_required',
      reason: 'realtime_byo_not_configured',
    });
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'update_required' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'update_required',
      reason: 'update_required',
    });
    const resources = (controllerInput as unknown as Readonly<{ resources: Readonly<{
      preflight(input: unknown): Promise<void>;
      prepare(input: unknown): Promise<void>;
      release(input: unknown): Promise<void>;
    }> }>).resources;
    await resources.release({ controlSessionId: 'session-1', attemptId: 1, reason: { code: 'user_stop' } });
    expect(mic.ensureActive).toHaveBeenCalledTimes(1);
    expect(mic.teardown).toHaveBeenCalledTimes(1);
    expect(host.acquireAudioMode).toHaveBeenCalledWith('realtime_example');
    expect(releaseAudioMode).toHaveBeenCalledTimes(1);
    expect(host.ensureBound).not.toHaveBeenCalled();
    expect(host.acquireDirectMediaConversation).toHaveBeenCalledWith({
      adapterId: 'realtime_example',
      controlSessionId: 'session-1',
      requestedTargetSessionAddress: null,
    });
    await runtime.adapter.stop({ sessionId: 'session-1' });
    await runtime.adapter.start({
      sessionId: 'session-1',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-1' },
    });
    let resolveLateMic!: () => void;
    mic.ensureActive.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveLateMic = resolve;
    }));
    await resources.preflight!({
      controlSessionId: 'session-1',
      attemptId: 2,
      request: {},
      signal: new AbortController().signal,
    });
    const lateMicPrepare = resources.prepare({
      controlSessionId: 'session-1',
      attemptId: 2,
      request: {},
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(mic.ensureActive).toHaveBeenCalledTimes(2);
    });
    let lateMicReleaseFinished = false;
    const lateMicRelease = resources.release({
      controlSessionId: 'session-1',
      attemptId: 2,
      reason: { code: 'user_stop' },
    }).then(() => {
      lateMicReleaseFinished = true;
    });
    await Promise.resolve();
    expect(lateMicReleaseFinished).toBe(false);
    resolveLateMic();
    await Promise.all([lateMicPrepare, lateMicRelease]);
    expect(mic.teardown).toHaveBeenCalledTimes(2);
    expect(releaseAudioMode).toHaveBeenCalledTimes(2);

    await runtime.adapter.stop({ sessionId: 'session-1' });
    await runtime.adapter.start({
      sessionId: 'session-1',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-1' },
    });
    mic.ensureActive.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { name: 'NotAllowedError' }));
    await expect(resources.prepare({
      controlSessionId: 'session-1',
      attemptId: 3,
      request: {},
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'declined', code: 'mic_permission_denied' });

    const createToolBarrier = (controllerInput as unknown as Readonly<{
      createToolBarrier(input: Readonly<{ controlSessionId: string; attemptId: number }>): Readonly<{
        submitResults(responseId: string, results: readonly unknown[], signal: AbortSignal): Promise<void>;
        continueResponse(responseId: string, signal: AbortSignal): Promise<void>;
      }>;
    }>).createToolBarrier;
    createToolBarrier({ controlSessionId: 'session-1', attemptId: 3 });
    const barrier = barrierInput!;
    const signal = new AbortController().signal;
    await barrier.submitResults('response-1', [], signal);
    await barrier.continueResponse('response-1', signal, 'synthetic');
    expect(sentEvents).toEqual([
      { type: 'tool.output' },
      'playback-drained',
      { type: 'response.create' },
    ]);

    sentEvents.length = 0;
    await expect(runtime.adapter.prepareTextTurn!({ controlSessionId: 'session-1', conversationSessionId: 'session-1', text: 'stale carrier text' })({ localId: 'voice-local-stale', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} })).rejects.toMatchObject({
      message: 'voice_transcript_carrier_changed',
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance',
    });
    expect(sentEvents).toEqual([]);

    // Typed admission, overlapping-turn ordering, Stop fencing and rejected native
    // sends are exercised through the registered public SDK tests above. Do not
    // manufacture a connected turn after this resource oracle declined capture.
    await expect(runtime.adapter.performRuntimeAction?.('forget_provider_conversation'))
      .resolves.toEqual({ status: 'completed' });
    await expect(runtime.adapter.performRuntimeAction?.('unknown'))
      .resolves.toEqual({ status: 'unsupported' });
    expect(sentEvents.at(-1)).toBe('forgot-provider-conversation');

    await runtime.adapter.interrupt({ sessionId: 'voice-global' });
    expect(interruptOrder).toEqual(['local-output-cleared', 'cancel_response', 'remote-output-cleared']);

    sendClientControl.mockResolvedValueOnce({ status: 'unavailable', code: 'voice_connection_not_open' });
    runtime.adapter.sendContextUpdate({ sessionId: 'voice-global', update: 'later context' });
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('voice_context_update_failed'));

    sentEvents.length = 0;
    // The public SDK journey above owns accepted/queued turn Stop fencing.
    // This resource oracle only owns teardown after declined capture.
    await runtime.adapter.stop({ sessionId: 'session-1' });
    getActiveControlSessionId.mockReturnValue(null);

    start.mockResolvedValueOnce({ status: 'failed', code: 'voice_context_update_failed' });
    await expect(runtime.adapter.start({
      sessionId: 'session-2',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-2' },
    })).rejects.toMatchObject({
      message: 'voice_context_update_failed',
      code: 'voice_context_update_failed',
    });
    expect(stop).toHaveBeenCalledTimes(3);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(4);

    start.mockResolvedValueOnce({ status: 'failed', code: 'machine unavailable at /Users/private/repository' });
    await expect(runtime.adapter.start({
      sessionId: 'session-unsafe-code',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-unsafe-code' },
    })).rejects.toMatchObject({
      message: 'voice_connection_failed',
      code: 'voice_connection_failed',
    });
    expect(stop).toHaveBeenCalledTimes(3);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(5);

    start.mockResolvedValueOnce({ status: 'declined', code: 'credential_unavailable' });
    await expect(runtime.adapter.start({
      sessionId: 'session-3',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-3' },
    })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(3);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(6);

    /*
     * A Start that ends without connecting and without informing the machine is
     * the one failure the surface cannot explain: it keeps whatever label it had
     * (including a stale "Connection Error") and no port records a reason.
     * `voice_provider_not_selected` is returned by the controller's pre-attempt
     * selection guard, before any machine transition, provider request or
     * microphone acquisition — so the runtime must name it here or it is
     * unrecoverable.
     */
    log.clear();
    start.mockResolvedValueOnce({ status: 'declined', code: 'voice_provider_not_selected' });
    await expect(runtime.adapter.start({
      sessionId: 'session-4',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-4' },
    })).resolves.toBeUndefined();
    const unsettledDecline = String(log.getLogs().at(-1));
    expect(unsettledDecline).toContain('[voiceRuntimeFailure]');
    expect(unsettledDecline).toContain('voice_provider_not_selected');
    expect(unsettledDecline).toContain('realtime_example');

    // An aborted start that never reached a terminal machine error is the same
    // unexplainable outcome and must be nameable once.
    log.clear();
    start.mockResolvedValueOnce({ status: 'aborted' });
    await expect(runtime.adapter.start({
      sessionId: 'session-5',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-5' },
    })).resolves.toBeUndefined();
    expect(String(log.getLogs().at(-1))).toContain('voice_start_not_settled');

    // A start the machine already named must not be reported twice.
    log.clear();
    start.mockImplementationOnce(async () => {
      controllerProtocol.machine.disconnected({
        controlSessionId: 'session-6',
        code: 'realtime_byo_not_configured',
      });
      return { status: 'declined', code: 'realtime_byo_not_configured' };
    });
    await expect(runtime.adapter.start({
      sessionId: 'session-6',
      requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'session-6' },
    })).resolves.toBeUndefined();
    expect(log.getLogs().filter(
      (message) => message.includes('[voiceRuntimeFailure]'),
    )).toHaveLength(1);

    await runtime.dispose();
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it('retains an admitted carrier tail through coalesced Stop and disposal after native audio release fails', async () => {
    platform.current = 'ios';
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.native-tail';
    const localId = 'sdk';
    const providerId = `${pluginId}/${localId}`;
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const recreatedSessionId = 'native-tail-recreated-carrier';
    const rebindStarted = createDeferredVoid();
    const releaseRebind = createDeferredVoid();
    const persistenceStarted = createDeferredVoid();
    const releasePersistence = createDeferredVoid();
    const audioRestoreEntered = createDeferredVoid();
    let callbacks: Parameters<VoiceSdkHandleConnectionDriver['open']>[0] | null = null;
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    let stopping: Promise<void> | null = null;
    let disposal: Promise<void> | null = null;
    let providerCloseCount = 0;
    const observedCarrierReleases: Array<{ conversationSessionId: string; settled: boolean }> = [];
    const { getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
    const { createVoiceTranscriptLadderMapper } = await import('@happier-dev/plugin-sdk/voice/client');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const ladder = createVoiceTranscriptLadderMapper();
    const restoreAudio = vi.mocked(nativeAudio.nativeModule.restoreAudioSession);
    restoreAudio.mockReset().mockImplementationOnce(async () => { audioRestoreEntered.resolve(); throw new Error('native_restore_failed'); }).mockResolvedValue(undefined);
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public native tail SDK', kind: 'conversation', platforms: ['ios'],
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'native-tail-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected native conversation declaration');
    const provider: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'provider_managed', setInputMuted: () => {},
      protocol: {
        async prepare({ signal }) { return signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } }; },
        decodeControl(event) {
          if (!isControlRecord(event)
            || typeof event.id !== 'string' || typeof event.item !== 'string' || typeof event.text !== 'string') return [];
          const transcript = ladder.map({ itemId: event.item, eventId: event.id, role: 'user', incoming: event.text, mode: 'final' });
          return transcript ? [{ type: 'transcript', event: transcript }] : [];
        },
        encodeTurnControl: () => null,
      },
      async createConnection({ media }) {
        return media.createSdkHandleConnection({ driver: {
          async open(input) { callbacks = input; },
          async sendControl() {}, async close() { providerCloseCount += 1; },
        } });
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ type: 'unused' }),
      encodeContextUpdate: () => [], encodeTextTurn: () => [],
    };
    environment.historySessionPost = async init => {
      rebindStarted.resolve();
      await releaseRebind.promise;
      return environment.sessionHttp.createSessionFromPost(recreatedSessionId, init);
    };
    environment.transcriptRequest.mockImplementation(async (input, init) => {
      const response = await environment.homeRequest(input, init);
      if (response) return response;
      expect(String(input)).toBe(environment.transcriptMessageUrl(recreatedSessionId));
      expect(init?.method).toBe('POST');
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== 'object' || !('localId' in body)) throw new Error('Expected canonical transcript request');
      persistenceStarted.resolve();
      await releasePersistence.promise;
      return Response.json({ didWrite: true, message: { id: 'native-tail-row', seq: 1, localId: body.localId, createdAt: Date.now() } });
    });
    try {
      scope = createExternalVoiceProviderActivationScope({
        pluginId, occurrenceId: 'native-tail-occurrence', declarations: [declaration], hostPlatform: 'ios',
        runtimeHost: { ...hostLease.host,
          releaseDirectMediaConversation(input) {
            const observed = { conversationSessionId: input.conversationSessionId, settled: false };
            observedCarrierReleases.push(observed);
            const release = hostLease.host.releaseDirectMediaConversation(input);
            void Promise.resolve(release).then(() => { observed.settled = true; }, () => { observed.settled = true; });
            return release;
          },
        },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
      });
      scope.api.voiceProviders.register(localId, provider);
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter) throw new Error('Public native SDK did not register');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { [providerId]: { schemaVersion: 1, config: {} } } });
      voiceSessionBindingStore.getState().bind({ adapterId: providerId, controlSessionId,
        conversationSessionId: environment.historySessionId,
        conversationSessionAddress: { serverId: environment.accountConnection.home.id, sessionId: environment.historySessionId },
        targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
      storage.getState().deleteSession(environment.historySessionId, environment.accountConnection.home.id);
      environment.sessionHttp.replaceSession(environment.historySessionId);
      const nativeCallbacks = callbacks as Parameters<VoiceSdkHandleConnectionDriver['open']>[0] | null;
      if (!nativeCallbacks) throw new Error('Native SDK did not open');
      nativeCallbacks.onControl({ id: 'before-native-end', item: 'before-native-end', text: 'Preserve the admitted native tail' });
      await rebindStarted.promise;
      let stopSettled = false;
      let duplicateStopSettled = false;
      let disposeSettled = false;
      stopping = adapter.stop({ sessionId: controlSessionId });
      const duplicateStop = adapter.stop({ sessionId: controlSessionId });
      disposal = Promise.resolve(scope.unwind());
      void stopping.then(() => { stopSettled = true; }, () => { stopSettled = true; });
      void duplicateStop.then(() => { duplicateStopSettled = true; }, () => { duplicateStopSettled = true; });
      void disposal.then(() => { disposeSettled = true; }, () => { disposeSettled = true; });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(duplicateStopSettled).toBe(false);
      expect(disposeSettled).toBe(false);
      releaseRebind.resolve();
      await persistenceStarted.promise;
      await audioRestoreEntered.promise;
      expect(restoreAudio).toHaveBeenCalled();
      // Observe the genuine projector/HTTP drain below invocation retirement;
      // a held response alone would not prove that its owner still awaited it.
      expect(observedCarrierReleases.filter(release => release.conversationSessionId === recreatedSessionId))
        .toEqual([{ conversationSessionId: recreatedSessionId, settled: false }]);
      expect(stopSettled).toBe(false);
      expect(duplicateStopSettled).toBe(false);
      expect(disposeSettled).toBe(false);
      releasePersistence.resolve();
      const results = await Promise.allSettled([stopping, duplicateStop, disposal]);
      expect(results.some(result => result.status === 'rejected')).toBe(true);
      expect(providerCloseCount).toBe(1);
      expect(readStoredSessionMessages(storage.getState(), recreatedSessionId)).toEqual([
        expect.objectContaining({ kind: 'user-text', text: 'Preserve the admitted native tail' }),
      ]);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId)).toBeNull();
      const coordinator = getSharedVoiceAudioSessionCoordinator();
      if (!coordinator) throw new Error('Missing actual native audio coordinator');
      const recovered = await coordinator.acquire({ ownerId: 'native-tail-recovery', mode: 'conversation', input: true,
        output: true, aec: 'preferred', capture: 'provider_managed_exclusive' });
      expect(coordinator.getSnapshot().pendingReleaseCount).toBe(0);
      await recovered.release();
      expect(coordinator.getSnapshot()).toMatchObject({ leaseCount: 0, pendingReleaseCount: 0, configuration: null });
    } finally {
      releaseRebind.resolve();
      releasePersistence.resolve();
      restoreAudio.mockResolvedValue(undefined);
      await stopping?.catch(() => {});
      await disposal?.catch(() => {});
      await Promise.resolve(scope?.unwind()).catch(() => {});
      hostLease.revoke();
      await environment.dispose();
      platform.current = 'web';
    }
  });

  it.each([429, 503])('retains the carrier rebind cause %i while naming real transcript refusals without authoritative words', async (status) => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new TypeError('private carrier response'), { status }), 'voice.transcript.rebind');
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const hostLease = createBundledConversationRuntimeHostLease();
    const pluginId = 'conformance.voice.transcript-refusal';
    const localId = 'sdk';
    const providerId = `${pluginId}/${localId}`;
    const controlSessionId = hostLease.host.globalVoiceSessionId;
    const privateWords = 'History Canary Delta 92';
    const observation: { deps: VoiceConversationControllerDeps | null; controller: VoiceConversationController | null;
      sdk: Parameters<VoiceSdkHandleConnectionDriver['open']>[0] | null } = { deps: null, controller: null, sdk: null };
    const { createVoiceTranscriptLadderMapper } = await import('@happier-dev/plugin-sdk/voice/client');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
    const ladder = createVoiceTranscriptLadderMapper();
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    let replacementHost: ReturnType<typeof createBundledConversationRuntimeHostLease> | null = null;
    const transcriptDrops = () => log.getLogs().filter(line => line.includes('[voiceRuntimeFailure]') && line.includes('transcript_dropped'));
    const final = (id: string) => {
      const event = ladder.map({ itemId: id, eventId: id, role: 'user', incoming: privateWords, mode: 'final' });
      if (!event) throw new Error('Expected the public transcript producer final');
      return event;
    };
    const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
      id: localId, title: 'Public transcript SDK', kind: 'conversation', platforms: ['web'],
      roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'transcript-refusal-client', exportName: 'activate' },
    }] }).voiceProviders[0]!;
    if (declaration.kind !== 'conversation') throw new Error('Expected conversation declaration');
    const provider: RealtimeVoiceProviderRuntime = {
      kind: 'conversation', microphoneMode: 'provider_managed', setInputMuted: () => {},
      protocol: {
        async prepare({ signal }) { return signal.aborted ? { kind: 'aborted' } : { kind: 'prepared', session: { config: null, safeMetadata: null } }; },
        decodeControl(event) {
          return isControlRecord(event) && typeof event.id === 'string'
            ? [{ type: 'transcript', event: final(event.id) }] : [];
        },
        encodeTurnControl: () => null,
      },
      async createConnection({ media }) {
        return media.createSdkHandleConnection({ driver: {
          async open(input) { observation.sdk = input; }, async sendControl() {}, async close() {},
        } });
      },
      encodeToolResults: () => [], encodeToolContinuation: () => ({ type: 'unused' }),
      encodeContextUpdate: () => [], encodeTextTurn: () => [],
    };
    try {
      scope = createExternalVoiceProviderActivationScope({
        pluginId, occurrenceId: 'transcript-refusal-occurrence', declarations: [declaration], hostPlatform: 'web',
        runtimeHost: { ...hostLease.host, createConversationController(input) {
          observation.deps = input;
          observation.controller = hostLease.host.createConversationController(input);
          return observation.controller;
        } },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
      });
      scope.api.voiceProviders.register(localId, provider);
      await scope.commit();
      const adapter = getExternalVoiceProviderRegistration(providerId)?.adapter;
      if (!adapter) throw new Error('Public transcript provider was not registered');
      registerVoiceAdapters([adapter]);
      await environment.configureVoice({ ...environment.persistedAccountSettings.voice, providerId,
        providers: { [providerId]: { schemaVersion: 1, config: {} } } });
      const target = { serverId: environment.accountConnection.home.id, sessionId: environment.historySessionId };
      await adapter.start({ sessionId: target.sessionId, requestedTargetSessionAddress: target, initialContext: '' });
      storage.getState().deleteSession(target.sessionId, target.serverId);
      environment.sessionHttp.replaceSession(target.sessionId);
      log.clear();
      environment.transcriptRequest.mockClear();
      observation.sdk!.onControl({ id: 'target-refused-one' });
      observation.sdk!.onControl({ id: 'target-refused-two' });
      await waitForTestEvent(notify => log.onChange(notify), () => transcriptDrops().length, count => count === 1);
      expect(transcriptDrops()).toHaveLength(1);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(transcriptDrops()).toHaveLength(1);
      // A targeted runtime binding survives deletion until its actual attempt
      // releases it. The genuine Sync writer refuses that missing Session.
      expect(transcriptDrops()[0]).toContain('transcript_persist_failed');
      expect(transcriptDrops()[0]).toContain('voice_transcript_persist_failed');
      expect(transcriptDrops()[0]).not.toContain(privateWords);
      expect(environment.transcriptRequest).not.toHaveBeenCalled();
      await adapter.stop({ sessionId: target.sessionId });

      environment.historySessionPost = async init => environment.sessionHttp.createSessionFromPost('refusal-global-carrier', init);
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null, initialContext: '' });
      const globalCarrier = voiceSessionBindingStore.getState().getByControlSessionId(controlSessionId)?.conversationSessionId;
      if (!globalCarrier) throw new Error('Expected the real recreated Global carrier');
      const attemptId = observation.controller!.getOwnedAttemptId();
      if (attemptId === null) throw new Error('Expected the real owned attempt identity');
      storage.getState().deleteSession(globalCarrier, target.serverId);
      environment.sessionHttp.replaceSession(globalCarrier);
      environment.historySessionPost = async () => { throw Object.assign(new TypeError('private carrier response'), { failureCause }); };
      log.clear();
      observation.sdk!.onControl({ id: 'global-rebind-refused-one' });
      await waitForTestEvent(notify => log.onChange(notify), () => transcriptDrops().length, count => count === 1);
      expect(transcriptDrops()).toHaveLength(1);
      observation.sdk!.onControl({ id: 'global-rebind-refused-two' });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(transcriptDrops()).toHaveLength(1);
      expect(transcriptDrops()[0]).toContain('transcript_carrier_rebind_failed');
      expect(JSON.parse(transcriptDrops()[0]!.slice(transcriptDrops()[0]!.indexOf('{')))).toMatchObject({ failureCause });
      expect(transcriptDrops()[0]).not.toContain(privateWords);
      expect(readStoredSessionMessages(storage.getState(), globalCarrier)).toEqual([]);
      await adapter.stop({ sessionId: controlSessionId });
      log.clear();
      // Observe the actual bound callback for a genuinely retired attempt. No
      // controller result, currentness flag or transcript owner is substituted.
      observation.deps!.projectTranscript!({ controlSessionId, attemptId, connectionId: 1, event: final('late-final-one') });
      observation.deps!.projectTranscript!({ controlSessionId, attemptId, connectionId: 1, event: final('late-final-two') });
      expect(transcriptDrops()).toHaveLength(1);
      expect(transcriptDrops()[0]).toContain('transcript_attempt_unowned');
      expect(transcriptDrops()[0]).not.toContain(privateWords);

      environment.historySessionPost = async init => environment.sessionHttp.createSessionFromPost('refusal-generation-carrier', init);
      // Recover verified Home transport through its real readiness owner before
      // asking a new Voice attempt to connect after the failed carrier request.
      const { invalidateServerReachabilitySupervisor, peekServerReachabilityState, subscribeServerReachabilityState } =
        await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
      const home = environment.accountConnection.home;
      const token = environment.accountConnection.credentials.token;
      await invalidateServerReachabilitySupervisor({ serverUrl: home.serverUrl, token });
      await waitForTestEvent(notify => subscribeServerReachabilityState(home.serverUrl, notify, token), () => peekServerReachabilityState(home.serverUrl, token)?.phase, phase => phase === 'online');
      expect(peekServerReachabilityState(home.serverUrl, token)?.phase).toBe('online');
      await adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null, initialContext: '' });
      const liveAttemptId = observation.controller!.getOwnedAttemptId();
      if (liveAttemptId === null) throw new Error('Expected current generation attempt');
      replacementHost = createBundledConversationRuntimeHostLease();
      log.clear();
      observation.deps!.projectTranscript!({ controlSessionId, attemptId: liveAttemptId, connectionId: 1, event: final('retired-generation-one') });
      observation.deps!.projectTranscript!({ controlSessionId, attemptId: liveAttemptId, connectionId: 1, event: final('retired-generation-two') });
      expect(transcriptDrops()).toHaveLength(1);
      // Replacing the real host synchronously disposes its registered runtime;
      // that stronger refusal precedes the bare generation-currentness check.
      expect(transcriptDrops()[0]).toContain('transcript_runtime_disposed');
      expect(transcriptDrops()[0]).not.toContain(privateWords);
    } finally {
      await scope?.unwind();
      replacementHost?.revoke();
      hostLease.revoke();
      await environment.dispose();
    }
  });

  it('names every refused authoritative transcript event exactly once per attempt', async () => {
    log.clear();
    let controllerInput: VoiceConversationControllerDeps | null = null;
    let resolvedConversationSessionId: string | null = 'carrier-1';
    let rebindFailure: Error | null = null;
    let pendingCarrierRebind: ReturnType<typeof createDeferredVoid> | null = null;
    let carrierRebindStarted: ReturnType<typeof createDeferredVoid> | null = null;
    let activeResourceAttemptId: number | null = null;
    let hostGenerationCurrent = true;
    let transcriptAttemptSequence = 0;
    let releaseReboundCarrier = createDeferredVoid();
    let rejectAudioModeRelease = false;
    const releaseAudioMode = vi.fn(async () => {
      if (rejectAudioModeRelease) throw new Error('audio_mode_release_failed');
    });
    const releaseDirectMediaConversation = vi.fn(async (input: Readonly<{
      conversationSessionId: string;
    }>) => {
      if (input.conversationSessionId === 'carrier-2') {
        await releaseReboundCarrier.promise;
      }
    });
    const onStopped = vi.fn();
    const mic = {
      ensureActive: vi.fn(async () => undefined),
      teardown: vi.fn(async () => undefined),
      setMuted: vi.fn(),
      isMuted: vi.fn(() => false),
      getStream: vi.fn(() => null),
      getAudioContext: vi.fn(() => null),
    };
    const projectTranscript = vi.fn(() => null);
    const controllerStop = vi.fn(async () => {
      const attemptId = activeResourceAttemptId;
      activeResourceAttemptId = null;
      if (attemptId === null) return;
      await controllerInput!.resources!.release({
        controlSessionId: 'voice-global',
        attemptId,
        reason: { code: 'user_stop' },
      }).catch(() => {});
    });
    const host = {
      globalVoiceSessionId: 'voice-global',
      isCurrentGeneration: () => hostGenerationCurrent,
      runCurrentGenerationEffect(callback: () => void): boolean {
        if (!hostGenerationCurrent) return false;
        callback();
        return true;
      },
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId: 'realtime_drop' } }),
      projectVoiceSettings: () => ({ providerId: 'realtime_drop', providerConfig: {} }),
      machine: {
        transitionToAcquiringMic: vi.fn(), transitionToConnecting: vi.fn(), transitionToConnected: vi.fn(),
        setReconnecting: vi.fn(), transitionToSpeaking: vi.fn(), transitionToEnding: vi.fn(),
        transitionToDisconnected: vi.fn(), setError: vi.fn(), setMuted: vi.fn(),
        getSnapshot: vi.fn(() => ({ status: 'disconnected' })),
        projectSnapshot: vi.fn(() => ({
          adapterId: 'realtime_drop', sessionId: null,
          status: 'disconnected' as const, mode: 'idle' as const, canStop: false,
        })),
        subscribe: vi.fn(() => vi.fn()),
      },
      createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
        controllerInput = input;
        return {
          start: vi.fn(async (): Promise<VoiceConversationControllerStartResult> => ({ status: 'connected' })),
          stop: controllerStop,
          fail: vi.fn(async () => undefined),
          performTurnControl: vi.fn(async () => ({ status: 'sent' as const })),
          sendClientControl: vi.fn(async () => ({ status: 'sent' as const })),
          getActiveControlSessionId: vi.fn((): string | null => 'voice-global'),
          getOwnedControlSessionId: vi.fn((): string | null => 'voice-global'),
          getOwnedAttemptId: vi.fn(() => 1),
          requestReconnect: vi.fn(async () => true),
          playbackCursorMs: vi.fn(() => 0),
          beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
          resolveOutputInterruptionCandidate: vi.fn(),
        };
      }),
      createMicSession: vi.fn(() => mic),
      openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
      ensureBound: vi.fn(async () => undefined),
      acquireDirectMediaConversation: vi.fn(async () => {
        if (rebindFailure) throw rebindFailure;
        const rebind = pendingCarrierRebind;
        if (rebind) {
          carrierRebindStarted?.resolve();
          await rebind.promise;
        }
        return { conversationSessionId: resolvedConversationSessionId ?? 'carrier-1' };
      }),
      releaseDirectMediaConversation,
      resolveConversationSessionId: vi.fn(() => resolvedConversationSessionId),
      applyTargetSelection: vi.fn(async () => undefined),
      acquireAudioMode: vi.fn(async () => ({ release: releaseAudioMode })),
      projectTranscript,
      settleTranscriptPersistence: vi.fn(async () => undefined),
      beginTranscriptAttempt: vi.fn(() => {
        transcriptAttemptSequence += 1;
        return {
          epoch: transcriptAttemptSequence,
          attemptIdentity: `attempt-drop-${transcriptAttemptSequence}`,
        };
      }),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({
        run: vi.fn(async () => ({ status: 'submitted' as const, results: [] })), cancel: vi.fn(() => false), dispose: vi.fn(),
      })),
      voiceHooks: { onStarted: vi.fn(() => ''), onStopped },
      createMachineError: vi.fn((input) => ({
        ...input, phase: 'runtime' as const, retryPolicy: 'user_action' as const,
        recoveryAction: 'retry' as const, presentation: 'error' as const, recoverable: true,
      })),
      createSdkHandleConnection: vi.fn(),
      createWebRtcConnection: vi.fn(),
      createWebSocketPcmMedia: vi.fn(),
      createWebSocketPcmConnection: vi.fn(),
    } as unknown as BundledRealtimeProviderRuntimeHost;
    const runtime = createBundledRealtimeProviderRuntime(host, {
      providerId: 'realtime_drop',
      execution: { kind: 'direct_media' },
      protocol: {
        id: 'realtime_drop',
        turnControls: {
          cancelResponse: 'immediate' as const, truncatePlayback: 'unsupported' as const,
          clearInput: true, stopSession: true, resumption: 'none' as const,
          exactMessage: true,
        },
        prepare: vi.fn(), decodeControl: vi.fn(), encodeTurnControl: vi.fn(),
      },
      microphoneMode: 'host_webrtc',
      createConnection: vi.fn(),
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'response.create' })),
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveSurfaceCapabilities: () => ({
        allowsGlobalStart: true, controlSessionScope: 'global',
        requiresVoiceAgentFeature: false, bargeInEnabled: false,
      }),
    });
    const authoritativeFinal = (eventId: string) => Object.freeze({
      v: 1 as const,
      epoch: 3,
      sequence: 1,
      revision: 1,
      eventId,
      role: 'user' as const,
      type: 'voice.transcript.final' as const,
      text: 'History Canary Delta 92',
      itemId: 'user-item-1',
      provenance: 'live' as const,
    });
    const transcriptDropRecords = () => log.getLogs()
      .filter((line) => line.includes('[voiceRuntimeFailure]') && line.includes('transcript_dropped'));

    try {
      // A targeted direct-media attempt whose carrier binding disappears mid-turn
      // cannot be re-acquired under a different identity. Refusing the write is
      // correct; destroying the user's authoritative words without a trace is not.
      await runtime.adapter.start({
        sessionId: 'target-session',
        requestedTargetSessionAddress: { serverId: 'server-a', sessionId: 'target-session' },
      });
      const runtimeEvents = controllerInput as unknown as Readonly<{
        projectTranscript(input: Readonly<{
          controlSessionId: string; attemptId: number; connectionId: number; event: unknown;
        }>): void;
      }>;
      await controllerInput!.resources!.preflight!({
        controlSessionId: 'target-session',
        attemptId: 1,
        request: {
          requestedTargetSessionAddress: {
            serverId: 'server-a',
            sessionId: 'carrier-1',
          },
        },
        signal: new AbortController().signal,
      });
      await controllerInput!.resources!.prepare({
        controlSessionId: 'target-session',
        attemptId: 1,
        request: {
          requestedTargetSessionAddress: {
            serverId: 'server-a',
            sessionId: 'carrier-1',
          },
        },
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 1;
      log.clear();
      resolvedConversationSessionId = null;
      runtimeEvents.projectTranscript({
        controlSessionId: 'target-session',
        attemptId: 1,
        connectionId: 1,
        event: authoritativeFinal('user-final-1'),
      });
      runtimeEvents.projectTranscript({
        controlSessionId: 'target-session',
        attemptId: 1,
        connectionId: 1,
        event: authoritativeFinal('user-final-2'),
      });
      expect(projectTranscript).not.toHaveBeenCalled();
      const targetedDrops = transcriptDropRecords();
      expect(targetedDrops).toHaveLength(1);
      expect(targetedDrops[0]).toContain('transcript_carrier_unavailable');
      expect(targetedDrops[0]).toContain('voice_transcript_conversation_unavailable');
      expect(targetedDrops[0]).toContain('realtime_drop');
      // The record must never carry what the user said.
      expect(targetedDrops[0]).not.toContain('History Canary Delta 92');
      await runtime.adapter.stop({ sessionId: 'voice-global' });
      releaseAudioMode.mockClear();
      releaseDirectMediaConversation.mockClear();
      onStopped.mockClear();

      // An authoritative final admitted before End owns its carrier rebind and
      // persistence drain. Starting release while acquisition is pending must
      // not turn that already-received final into a superseded drop, and the
      // public stop cannot settle before the rebound carrier's admitted writes.
      resolvedConversationSessionId = 'carrier-1';
      await runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await controllerInput!.resources!.preflight!({
        controlSessionId: 'voice-global',
        attemptId: 2,
        request: {},
        signal: new AbortController().signal,
      });
      await controllerInput!.resources!.prepare({
        controlSessionId: 'voice-global',
        attemptId: 2,
        request: {},
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 2;
      // Generation replacement wins authority synchronously, before its old
      // runtime enters disposal. A new final in that interval has not crossed
      // the retiring-tail custody boundary and must not begin a carrier write.
      hostGenerationCurrent = false;
      log.clear();
      projectTranscript.mockClear();
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 2,
        connectionId: 1,
        event: authoritativeFinal('user-final-after-generation-replacement'),
      });
      expect(projectTranscript).not.toHaveBeenCalled();
      expect(transcriptDropRecords()).toHaveLength(1);
      expect(transcriptDropRecords()[0]).toContain('transcript_generation_retired');
      hostGenerationCurrent = true;
      rejectAudioModeRelease = true;
      resolvedConversationSessionId = null;
      pendingCarrierRebind = createDeferredVoid();
      carrierRebindStarted = createDeferredVoid();
      log.clear();
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 2,
        connectionId: 1,
        event: authoritativeFinal('user-final-before-stop'),
      });
      await carrierRebindStarted.promise;
      let stopSettled = false;
      const stopping = runtime.adapter.stop({ sessionId: 'voice-global' }).then(() => {
        stopSettled = true;
      });
      // The controller is still waiting for the admitted final's carrier rebind,
      // before resources.release registers its transcript drain by attempt id.
      let duplicateStopSettled = false;
      const duplicateStopping = runtime.adapter.stop({ sessionId: 'voice-global' }).then(() => {
        duplicateStopSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopSettled).toBe(false);
      expect(duplicateStopSettled).toBe(false);
      expect(releaseDirectMediaConversation).not.toHaveBeenCalled();
      expect(onStopped).not.toHaveBeenCalled();
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 2,
        connectionId: 1,
        event: authoritativeFinal('user-final-after-stop-started'),
      });
      resolvedConversationSessionId = 'carrier-2';
      pendingCarrierRebind.resolve();
      await vi.waitFor(() => expect(
        releaseDirectMediaConversation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        conversationSessionId: 'carrier-2',
      })));
      expect(releaseDirectMediaConversation.mock.calls.filter(
        ([input]) => (input as Readonly<{ conversationSessionId?: string }>).conversationSessionId === 'carrier-2',
      )).toHaveLength(1);
      expect(releaseAudioMode).toHaveBeenCalledTimes(1);
      expect(stopSettled).toBe(false);
      expect(duplicateStopSettled).toBe(false);
      releaseReboundCarrier.resolve();
      await Promise.all([stopping, duplicateStopping]);
      await expect(controllerInput!.resources!.release({
        controlSessionId: 'voice-global',
        attemptId: 2,
        reason: { code: 'user_stop' },
      })).rejects.toThrow('audio_mode_release_failed');
      // The transcript drain is already settled, but native cleanup still owns
      // its lease until restoration succeeds. Retry that same resource release.
      rejectAudioModeRelease = false;
      await controllerInput!.resources!.release({
        controlSessionId: 'voice-global',
        attemptId: 2,
        reason: { code: 'user_stop' },
      });
      expect(releaseDirectMediaConversation.mock.calls.filter(
        ([input]) => (input as Readonly<{ conversationSessionId?: string }>).conversationSessionId === 'carrier-2',
      )).toHaveLength(1);
      expect(releaseAudioMode).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(projectTranscript).toHaveBeenCalledWith(expect.objectContaining({
        conversationSessionId: 'carrier-2',
        event: expect.objectContaining({ eventId: 'user-final-before-stop' }),
      })));
      expect(projectTranscript).toHaveBeenCalledTimes(1);
      expect(projectTranscript).not.toHaveBeenCalledWith(expect.objectContaining({
        event: expect.objectContaining({ eventId: 'user-final-after-stop-started' }),
      }));
      expect(transcriptDropRecords()).toHaveLength(1);
      expect(transcriptDropRecords()[0]).toContain('transcript_carrier_unavailable');

      // A targetless attempt whose carrier recreation fails loses the same words
      // through the other branch, and must be nameable there too.
      resolvedConversationSessionId = 'carrier-1';
      pendingCarrierRebind = null;
      carrierRebindStarted = null;
      await runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await controllerInput!.resources!.preflight!({
        controlSessionId: 'voice-global',
        attemptId: 3,
        request: {},
        signal: new AbortController().signal,
      });
      await controllerInput!.resources!.prepare({
        controlSessionId: 'voice-global',
        attemptId: 3,
        request: {},
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 3;
      log.clear();
      projectTranscript.mockClear();
      resolvedConversationSessionId = null;
      rebindFailure = new Error('carrier_recreation_unavailable');
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 3,
        connectionId: 1,
        event: authoritativeFinal('user-final-3'),
      });
      await waitForTestEvent(notify => log.onChange(notify), () => transcriptDropRecords().length, count => count === 1);
      expect(transcriptDropRecords()).toHaveLength(1);
      expect(transcriptDropRecords()[0]).toContain('transcript_carrier_rebind_failed');
      expect(projectTranscript).not.toHaveBeenCalled();

      // A late event after End Voice is fenced deliberately, but the fence is
      // still a lost authoritative word and is named once, not once per event.
      await runtime.adapter.stop({ sessionId: 'voice-global' });
      log.clear();
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 3,
        connectionId: 1,
        event: authoritativeFinal('user-final-4'),
      });
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 3,
        connectionId: 1,
        event: authoritativeFinal('user-final-5'),
      });
      const fencedDrops = transcriptDropRecords();
      expect(fencedDrops).toHaveLength(1);
      expect(fencedDrops[0]).toContain('transcript_attempt_unowned');

      // Disposal is another End Voice entrypoint. It must join the same
      // attempt-scoped Stop/drain owner rather than clearing its custody while
      // an admitted final still waits for carrier rebind and persistence.
      rebindFailure = null;
      pendingCarrierRebind = null;
      carrierRebindStarted = null;
      releaseReboundCarrier = createDeferredVoid();
      resolvedConversationSessionId = 'carrier-1';
      projectTranscript.mockClear();
      log.clear();
      releaseAudioMode.mockClear();
      // Disposal joins the drain even when the fallible native audio release rejects.
      rejectAudioModeRelease = true;
      releaseDirectMediaConversation.mockClear();
      onStopped.mockClear();
      controllerStop.mockClear();
      await runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await controllerInput!.resources!.preflight!({
        controlSessionId: 'voice-global',
        attemptId: 4,
        request: {},
        signal: new AbortController().signal,
      });
      await controllerInput!.resources!.prepare({
        controlSessionId: 'voice-global',
        attemptId: 4,
        request: {},
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 4;
      pendingCarrierRebind = createDeferredVoid();
      carrierRebindStarted = createDeferredVoid();
      resolvedConversationSessionId = null;
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 4,
        connectionId: 1,
        event: authoritativeFinal('user-final-before-dispose'),
      });
      await carrierRebindStarted.promise;

      let disposalSettled = false;
      let duplicateDisposalSettled = false;
      let stopSettledDuringDisposal = false;
      let duplicateStopSettledDuringDisposal = false;
      const disposal = runtime.dispose();
      const duplicateDisposal = runtime.dispose();
      expect(duplicateDisposal).toBe(disposal);
      void disposal.then(() => {
        disposalSettled = true;
      });
      void duplicateDisposal.then(() => {
        duplicateDisposalSettled = true;
      });
      const stoppingDuringDisposal = runtime.adapter.stop({ sessionId: 'voice-global' });
      const duplicateStoppingDuringDisposal = runtime.adapter.stop({ sessionId: 'voice-global' });
      expect(duplicateStoppingDuringDisposal).toBe(stoppingDuringDisposal);
      void stoppingDuringDisposal.then(() => {
        stopSettledDuringDisposal = true;
      });
      void duplicateStoppingDuringDisposal.then(() => {
        duplicateStopSettledDuringDisposal = true;
      });

      await Promise.resolve();
      expect(disposalSettled).toBe(false);
      expect(duplicateDisposalSettled).toBe(false);
      expect(stopSettledDuringDisposal).toBe(false);
      expect(duplicateStopSettledDuringDisposal).toBe(false);
      expect(releaseDirectMediaConversation).not.toHaveBeenCalled();

      resolvedConversationSessionId = 'carrier-2';
      pendingCarrierRebind.resolve();
      await vi.waitFor(() => expect(
        releaseDirectMediaConversation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        conversationSessionId: 'carrier-2',
      })));
      expect(releaseDirectMediaConversation.mock.calls.filter(
        ([input]) => (input as Readonly<{ conversationSessionId?: string }>).conversationSessionId === 'carrier-2',
      )).toHaveLength(1);
      expect(releaseAudioMode).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(projectTranscript).toHaveBeenCalledWith(expect.objectContaining({
        conversationSessionId: 'carrier-2',
        event: expect.objectContaining({ eventId: 'user-final-before-dispose' }),
      })));
      expect(projectTranscript).toHaveBeenCalledTimes(1);

      // The rejected fallible audio release must not cause any caller to skip
      // the already-admitted carrier drain or settle before that same drain.
      await Promise.resolve();
      expect(disposalSettled).toBe(false);
      expect(duplicateDisposalSettled).toBe(false);
      expect(stopSettledDuringDisposal).toBe(false);
      expect(duplicateStopSettledDuringDisposal).toBe(false);
      expect(controllerStop).toHaveBeenCalledTimes(1);
      expect(onStopped).not.toHaveBeenCalled();

      releaseReboundCarrier.resolve();
      await Promise.all([
        disposal,
        duplicateDisposal,
        stoppingDuringDisposal,
        duplicateStoppingDuringDisposal,
      ]);
      expect(onStopped).toHaveBeenCalledTimes(1);
      // The disposal phase really ran with a rejecting native audio release.
      await expect(releaseAudioMode.mock.results[0]!.value).rejects.toThrow('audio_mode_release_failed');
      rejectAudioModeRelease = false;
    } finally {
      pendingCarrierRebind?.resolve();
      releaseReboundCarrier.resolve();
      await runtime.dispose();
    }
  });
});
