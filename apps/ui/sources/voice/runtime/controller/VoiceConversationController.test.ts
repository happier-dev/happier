import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred as deferred, waitForTestEvent } from '@/dev/testkit';
import type { VoiceRealtimeJsonValue, VoiceRealtimeToolCallV1 } from '@happier-dev/protocol';
import type { PartialOptions as ElevenLabsSdkStartOptions } from '@elevenlabs/client';

import type {
  VoiceRealtimeConnection,
  VoiceRealtimeTransportEvent,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import { createSdkHandleConnection, createWebRtcConnection, VOICE_WEBRTC_LIMITS, type VoiceConnectionDriver } from '@/voice/runtime/connection/VoiceRealtimeConnection';
import { installVoiceWebRtcBrowserBoundary, TestVoiceWebRtcPeer } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { createXaiVoiceRuntimeEnvironment, XaiVoiceWebSocket } from '@/dev/testkit/harness/xaiVoiceRuntime';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { log } from '@/log';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import { createRealtimeToolBarrier } from '@/voice/tools/realtimeToolBarrier';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { createOpenAiRealtimeProtocolAdapter, encodeOpenAiRealtimeClientEvent } from '../../../../../../packages/plugins/openai/src/ui/voice/protocol';
import { OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS } from '../../../../../../packages/plugins/openai/src/ui/voice/connection';
import {
  createVoiceConversationController,
  type VoiceConversationControllerDeps,
} from './VoiceConversationController';

const elevenLabsSdk = vi.hoisted(() => ({
  startSession: vi.fn(),
  endSession: vi.fn(async () => {}),
  setMicMuted: vi.fn(),
  setVolume: vi.fn(),
  sendUserMessage: vi.fn(),
  sendContextualUpdate: vi.fn(),
}));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: elevenLabsSdk.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: elevenLabsSdk.startSession } }));
vi.mock('socket.io-client', async importOriginal => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-audio', async () => (
  await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock());
installDisconnectedServerSocketBoundary();

// Compose the real transcript/storage graph during collection, before the
// projection and tool-barrier behavior is measured by the test deadline.
const {
  projectCanonicalVoiceTranscriptEvent,
  readCanonicalVoiceTranscriptSnapshot,
} = await import('@/voice/transcript/voiceConversationTranscript');
await loadSyncSingletonForTests();

// Only the vendor SDK session is supplied; activation, preparation, context
// encoding, the controller and lifecycle remain the generated real owners.
function createElevenLabsSdkSession(sessionId: string) {
  return {
    getId: () => sessionId,
    endSession: elevenLabsSdk.endSession,
    setMicMuted: elevenLabsSdk.setMicMuted,
    setVolume: elevenLabsSdk.setVolume,
    sendUserMessage: elevenLabsSdk.sendUserMessage,
    sendContextualUpdate: elevenLabsSdk.sendContextualUpdate,
  };
}

function createConnectionFixture(kind: 'sdk_handle' | 'webrtc' = 'sdk_handle') {
  const connectEntered = deferred<void>();
  const events: VoiceRealtimeJsonValue[] = [];
  const transportEvents: VoiceRealtimeTransportEvent[] = [];
  if (kind === 'sdk_handle') {
    let sdkCallbacks: Parameters<VoiceConnectionDriver['open']>[0] | null = null;
    const connect = vi.fn(async (_signal: AbortSignal) => {});
    const close = vi.fn(async (_reason: Parameters<VoiceRealtimeConnection['close']>[0]) => {});
    const sendControl = vi.fn(async (_event: VoiceRealtimeJsonValue) => {});
    const beginOutputInterruptionCandidate = vi.fn(() => 'ducked' as const);
    const resolveOutputInterruptionCandidate = vi.fn();
    const setOutputFocusState = vi.fn(() => 'applied' as const);
    const connection: { -readonly [Key in keyof VoiceRealtimeConnection]: VoiceRealtimeConnection[Key] } = createSdkHandleConnection({ driver: {
      open: async input => {
        sdkCallbacks = input;
        connectEntered.resolve();
        await connect(input.signal);
        for (const event of transportEvents.splice(0)) input.onTransport(event);
        for (const event of events.splice(0)) input.onControl(event);
      },
      close, sendControl, beginOutputInterruptionCandidate, resolveOutputInterruptionCandidate,
      setOutputFocusState,
    } });
    const finishEvents = () => sdkCallbacks?.onRemoteClose('sdk_remote_closed');
    return { connection, connect, connectEntered: connectEntered.promise, close, sendControl, beginOutputInterruptionCandidate,
      resolveOutputInterruptionCandidate, setOutputFocusState, events, transportEvents,
      emitControl: (event: VoiceRealtimeJsonValue) => sdkCallbacks?.onControl(event),
      emitTransport: (event: VoiceRealtimeTransportEvent) => sdkCallbacks?.onTransport(event),
      finishEvents,
      failControlEvents: (_reason: unknown) => finishEvents(),
      failTransportEvents: (_reason: unknown) => finishEvents(),
      failEvents: (_reason: unknown) => finishEvents(),
    };
  }
  const peer = new TestVoiceWebRtcPeer();
  const connect = vi.fn(async (_signal: AbortSignal) => {});
  const close = vi.fn(async (_reason: Parameters<VoiceRealtimeConnection['close']>[0]) => {});
  const sendControl = vi.fn(async (_event: VoiceRealtimeJsonValue) => {});
  const beginOutputInterruptionCandidate = vi.fn(() => 'unsupported' as const);
  const resolveOutputInterruptionCandidate = vi.fn();
  const setOutputFocusState = vi.fn(() => 'applied' as const);
  const emitTransport = (event: VoiceRealtimeTransportEvent) => {
    if (event.type === 'webrtc_ice_state') {
      peer.iceConnectionState = event.state;
      peer.dispatchEvent(new Event('iceconnectionstatechange'));
    } else if (event.type === 'webrtc_remote_track') {
      peer.remoteTrack(event.track as MediaStreamTrack, event.streams as readonly MediaStream[]);
    }
  };
  const originalSetRemoteDescription = peer.setRemoteDescription.getMockImplementation()!;
  peer.setRemoteDescription.mockImplementation(async (...args) => {
    await originalSetRemoteDescription(...args);
    peer.channel.open();
  });
  const connection: { -readonly [Key in keyof VoiceRealtimeConnection]: VoiceRealtimeConnection[Key] } = createWebRtcConnection({
    micStream: { getAudioTracks: () => [] } as unknown as MediaStream,
    duckGain: 0.18,
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    signaling: { exchangeOffer: async ({ signal }) => {
      connectEntered.resolve();
      await connect(signal);
      return { answerSdp: 'v=0\r\na=test-answer\r\n' };
    } },
    control: { label: 'oai-events', onOpen: () => {
      // Real browser events occur after negotiation. Pace separate physical
      // events so each reaches the real controller before terminal ICE loss.
      setTimeout(() => { void (async () => {
        for (const event of events.splice(0)) peer.channel.message(JSON.stringify(event));
        for (const event of transportEvents.splice(0)) {
          emitTransport(event);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      })(); }, 0);
    } },
    onClosed: close,
  });
  vi.spyOn(peer.channel, 'send').mockImplementation(serialized => {
    void sendControl(JSON.parse(serialized));
  });
  const finishEvents = () => peer.channel.close();
  const failControlEvents = (reason: unknown) => {
    const code = reason instanceof Error ? (reason as Error & { code?: string }).code : null;
    if (code === 'voice_webrtc_control_malformed') {
      peer.channel.message('not-json');
    } else if (code === 'voice_connection_inbound_overflow') {
      for (let index = 0; index < 258; index += 1) peer.channel.message(JSON.stringify({ index }));
    } else {
      finishEvents();
    }
  };
  return { connection, connect, connectEntered: connectEntered.promise, close, sendControl, beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate, setOutputFocusState, events, transportEvents,
    emitControl: (event: VoiceRealtimeJsonValue) => peer.channel.message(JSON.stringify(event)),
    emitTransport, finishEvents, failControlEvents,
    failTransportEvents: failControlEvents, failEvents: failControlEvents,
  };
}

// Unconverted internal fixture: its preparation/capabilities are not facts
// produced by OpenAI. Keep unique vectors until their actual generated-provider
// keeper is proven; do not interpret this fixture's failures as provider defects.
function createAdapter(overrides: Partial<VoiceRealtimeProtocolAdapter> = {}): VoiceRealtimeProtocolAdapter {
  return {
    ...createOpenAiRealtimeProtocolAdapter({ prepare: async () => ({ kind: 'declined', code: 'unused' }) }),
    id: 'fixture_provider',
    turnControls: {
      cancelResponse: 'immediate',
      truncatePlayback: 'played_ms',
      clearInput: true,
      stopSession: true,
      resumption: 'resume',
      replay: 'stable_ids',
      exactMessage: false,
    },
    prepare: async () => ({
      kind: 'prepared',
      session: {
        config: { session: 'fixture' },
        safeMetadata: null,
        toolResultReplay: 'stable_ids',
      },
    }),
    ...overrides,
  };
}

function openAiToolResponse(responseId: string, calls: readonly VoiceRealtimeToolCallV1[]): VoiceRealtimeJsonValue {
  return { type: 'response.done', event_id: `event-${responseId}`, response: {
    id: responseId, status: 'completed', output: calls.map(call => ({
      type: 'function_call', call_id: call.callId, name: call.toolName, arguments: JSON.stringify(call.arguments),
    })),
  } };
}

const machineSubscriptions: Array<() => void> = [];
const ownedRuntimeCleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  elevenLabsSdk.startSession.mockReset();
  elevenLabsSdk.endSession.mockClear();
  elevenLabsSdk.setMicMuted.mockClear();
  elevenLabsSdk.setVolume.mockClear();
  elevenLabsSdk.sendUserMessage.mockClear();
  elevenLabsSdk.sendContextualUpdate.mockClear();
  log.clear();
  createVoiceConversationRuntimeMachine().reset();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const unsubscribe of machineSubscriptions.splice(0)) unsubscribe();
  for (const cleanup of ownedRuntimeCleanups.splice(0)) await cleanup();
  createVoiceConversationRuntimeMachine().reset();
});

function createMachineFixture() {
  const transitions: string[] = [];
  const failureCodes: string[] = [];
  const runtimeMachine = createVoiceConversationRuntimeMachine();
  let observedControlSessionId: string | null = null;
  machineSubscriptions.push(useVoiceConversationRuntimeStore.subscribe((next, previous) => {
    const snapshot = next.snapshot;
    const before = previous.snapshot;
    if (!observedControlSessionId || snapshot.controlSessionId !== observedControlSessionId) return;
    if (snapshot.reconnecting !== before.reconnecting) {
      transitions.push(snapshot.reconnecting ? 'reconnecting' : 'reconnect-settled');
    }
    if (snapshot.state !== before.state) {
      transitions.push(snapshot.state === 'error' ? 'failed' : snapshot.state);
    }
    if (snapshot.error && snapshot.error !== before.error) failureCodes.push(snapshot.error.reason);
  }));
  return {
    transitions,
    failureCodes,
    getSnapshot: runtimeMachine.getSnapshot,
    machine: {
      connecting: (input) => {
        observedControlSessionId = input.controlSessionId;
        runtimeMachine.transitionToConnecting(input);
      },
      reconnecting: ({ active, ...input }) => {
        runtimeMachine.setReconnecting({ ...input, reconnecting: active });
      },
      connected: (input) => runtimeMachine.transitionToConnected(input),
      ending: (input) => runtimeMachine.transitionToEnding(input),
      disconnected: (input) => runtimeMachine.transitionToDisconnected(input),
      failed: ({ code, ...input }) => {
        runtimeMachine.setError({ ...input, error: createVoiceMachineError({ kind: 'provider_error', reason: code }) });
      },
    } satisfies VoiceConversationControllerDeps['machine'],
  };
}

describe('VoiceConversationController', () => {
  it('settles an actual OpenAI auth-refresh refusal without reconnecting or reminting', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      browser.peer.channel.open();
      await starting;
      const mintCount = environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets')).length;
      browser.peer.channel.message(JSON.stringify({
        type: 'error', event_id: 'refused-auth-refresh',
        error: { type: 'invalid_request_error', code: 'invalid_client_secret', message: 'private-provider-detail' },
      }));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().errorCode,
        code => code === 'voice_auth_refresh_failed');
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'voice_auth_refresh_failed' });
      expect(composed.controller?.getOwnedAttemptId()).toBeNull();
      expect(browser.peers).toHaveLength(1);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(mintCount);
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(log.getLogs().join('\n')).not.toContain('private-provider-detail');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('ends an expired OpenAI session with its typed cause and no automatic remint or reconnect', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      browser.peer.channel.message(JSON.stringify({
        type: 'error', event_id: 'expired-session',
        error: { code: 'session_expired', message: 'private-provider-detail' },
      }));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().errorCode, code => code === 'voice_session_expired');
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error', errorCode: 'voice_session_expired',
      });
      expect(composed.controller?.getActiveControlSessionId()).toBeNull();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      expect(log.getLogs().join('\n')).not.toContain('private-provider-detail');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('keeps transcription and tool errors nonterminal while delivering their sanitized diagnostics', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      log.clear();
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed', event_id: 'failed-transcription',
        item_id: 'input', content_index: 0, error: { message: 'private-provider-detail' },
      }));
      browser.peer.channel.message(JSON.stringify({
        type: 'error', event_id: 'failed-tool', error: { code: 'invalid_request_error', message: 'private-provider-detail' },
      }));
      await waitForTestEvent(notify => log.onChange(notify), () => log.getLogs().filter(line => line.includes('"outcome":"provider_error"')).length, count => count === 2);
      expect(log.getLogs().filter(line => line.includes('"outcome":"provider_error"'))).toHaveLength(2);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(composed.controller?.getActiveControlSessionId()).toBe(composed.controlSessionId);
      expect(browser.peer.close).not.toHaveBeenCalled();
      const diagnostics = log.getLogs().filter(line => line.includes('"outcome":"provider_error"'));
      expect(diagnostics.join('\n')).toContain('voice_transcription_failed');
      expect(diagnostics.join('\n')).toContain('provider_response_invalid');
      expect(diagnostics.join('\n')).not.toContain('private-provider-detail');
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed', event_id: 'next-input',
        item_id: 'next-input', transcript: 'the conversation remains usable',
      }));
      await waitForTestEvent(storage.subscribe, () => readCanonicalVoiceTranscriptSnapshot(composed.historySessionId), entries => entries.some(entry => entry.text === 'the conversation remains usable'));
      expect(readCanonicalVoiceTranscriptSnapshot(composed.historySessionId)).toEqual([
        expect.objectContaining({ role: 'user', text: 'the conversation remains usable' }),
      ]);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('latches a transient output suspension onto a connection that arrives after focus loss', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup), { autoStart: false });
    let suspendedBeforeConnection = false;
    machineSubscriptions.push(useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => {
      if (suspendedBeforeConnection || snapshot.controlSessionId !== conversation.controlSessionId || snapshot.state !== 'connecting') return;
      expect(conversation.getConnection()).toBeNull();
      expect(conversation.adapter.setOutputFocusState?.({ sessionId: conversation.controlSessionId, state: 'suspended' })).toBe('applied');
      suspendedBeforeConnection = true;
    }));
    await conversation.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
    expect(suspendedBeforeConnection).toBe(true);
    expect(conversation.context.gain.setTargetAtTime.mock.calls[0]?.[0]).toBe(0);
    await conversation.startOutput();
    expect(conversation.context.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, conversation.context.currentTime, 0.015);
    expect(conversation.adapter.setOutputFocusState?.({ sessionId: conversation.controlSessionId, state: 'active' })).toBe('applied');
    expect(conversation.context.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, conversation.context.currentTime, 0.015);
    expect(conversation.context.sources[0]?.start).toHaveBeenCalled();
  });

  it('starts a fresh attempt with active output focus after its suspended predecessor ends', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup));
    const firstContext = conversation.context;
    expect(conversation.adapter.setOutputFocusState?.({ sessionId: conversation.controlSessionId, state: 'suspended' })).toBe('applied');
    expect(firstContext.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, firstContext.currentTime, 0.015);
    await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
    expect(firstContext.close).toHaveBeenCalledTimes(1);
    // The native audio-session owner may recover focus while no Voice attempt
    // exists, so that recovery is intentionally not delivered to this controller.
    await conversation.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
    expect(conversation.context).not.toBe(firstContext);
    expect(conversation.context.gain.setTargetAtTime.mock.calls[0]?.[0]).toBe(1);
    await conversation.startOutput();
    expect(conversation.context.sources[0]?.start).toHaveBeenCalled();
    expect(conversation.context.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, conversation.context.currentTime, 0.015);
    expect(conversation.adapter.getSnapshot().status).toBe('connected');
  });

  it('routes provisional output interruption through only the currently owned connection', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup), { autoStart: false });
    const controller = conversation.getController();
    expect(controller.beginOutputInterruptionCandidate()).toBe('unsupported');
    await conversation.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
    await conversation.startOutput();
    const originalSource = conversation.context.sources[0]!;
    expect(controller.beginOutputInterruptionCandidate()).toBe('retained');
    expect(originalSource.stop).toHaveBeenCalledTimes(1);
    controller.resolveOutputInterruptionCandidate('false_alarm');
    expect(conversation.context.sources).toHaveLength(2);
    expect(conversation.context.sources[1]?.start).toHaveBeenCalled();
    await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
    const sourceCountAfterStop = conversation.context.sources.length;
    expect(controller.beginOutputInterruptionCandidate()).toBe('unsupported');
    controller.resolveOutputInterruptionCandidate('false_alarm');
    expect(conversation.context.sources).toHaveLength(sourceCountAfterStop);
  });

  it('declines a stale provider selection before acquiring attempt resources', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      await environment.configureVoice({ ...environment.persistedAccountSettings.voiceSettingsV1, providerId: 'off' });
      const before = createVoiceConversationRuntimeMachine().getSnapshot();
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(createVoiceConversationRuntimeMachine().getSnapshot()).toEqual(before);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(environment.providerFetch).not.toHaveBeenCalled();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.micSession.teardown).not.toHaveBeenCalled();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      expect(log.getLogs().join('\n')).toContain('voice_provider_not_selected');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('never acquires attempt resources when the attempt is retired during credential preparation', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const mint = deferred<void>();
    const mintEntered = deferred<void>();
    const respond = environment.providerFetch.getMockImplementation();
    if (!respond) throw new Error('OpenAI HTTP boundary unavailable');
    environment.providerFetch.mockImplementation(async (...args) => {
      mintEntered.resolve();
      await mint.promise;
      return await respond(...args);
    });
    const createHistoryCarrier = vi.fn(environment.historySessionPost);
    environment.historySessionPost = createHistoryCarrier;
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([mintEntered.promise, starting]);
      expect(environment.providerFetch).toHaveBeenCalledOnce();
      const stopping = composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      mint.resolve();
      await starting;
      await stopping;
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      expect(createHistoryCarrier).not.toHaveBeenCalled();
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
    } finally {
      mint.resolve();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('passes the provider-neutral start request through preparation without interpreting it', async () => {
    const { withGeneratedElevenLabsVoiceRuntime } = await import('@/dev/testkit/harness/elevenLabsVoiceRuntime');
    elevenLabsSdk.startSession.mockResolvedValue(createElevenLabsSdkSession('elevenlabs-start-request'));
    await withGeneratedElevenLabsVoiceRuntime(async ({ adapter }) => {
      await adapter.start({ sessionId: '', requestedTargetSessionAddress: null, textOnly: true, initialContext: 'context' });
      expect(elevenLabsSdk.startSession).toHaveBeenCalledTimes(1);
      expect(elevenLabsSdk.startSession.mock.calls[0]?.[0]).toMatchObject({
        textOnly: true,
        overrides: { conversation: { textOnly: true } },
        dynamicVariables: { initialConversationContext: 'context' },
      });
      expect(adapter.getSnapshot().status).toBe('connected');
      expect(elevenLabsSdk.sendContextualUpdate).not.toHaveBeenCalled();
      await adapter.stop({ sessionId: adapter.getSnapshot().sessionId ?? '' });
      expect(elevenLabsSdk.endSession).toHaveBeenCalledTimes(1);
    });
  });

  it('admits actual OpenAI client authority before acquiring media and creating its offer', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      const mintIndex = environment.providerFetch.mock.calls.findIndex(([url]) => String(url).endsWith('/client_secrets'));
      expect(mintIndex).toBeGreaterThanOrEqual(0);
      expect(globalThis.navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
      expect(browser.peer.createOffer).toHaveBeenCalled();
      const mintOrder = environment.providerFetch.mock.invocationCallOrder[mintIndex]!;
      const captureOrder = vi.mocked(globalThis.navigator.mediaDevices.getUserMedia).mock.invocationCallOrder[0]!;
      const offerOrder = browser.peer.createOffer.mock.invocationCallOrder[0]!;
      expect(mintOrder).toBeLessThan(captureOrder);
      expect(captureOrder).toBeLessThan(offerOrder);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('releases attempt resources exactly once for declined starts and connected stops', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const voice = environment.persistedAccountSettings.voiceSettingsV1;
    const providerId = environment.entry.providerId;
    await environment.configureVoice({ ...voice, providers: { ...voice.providers,
      [providerId]: { schemaVersion: 1, config: { ...readVoiceProviderSettingsConfig(voice, providerId), turnDetection: 'not-a-turn-mode' } },
    } });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(environment.providerFetch).not.toHaveBeenCalled();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(browser.micSession.teardown).not.toHaveBeenCalled();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(log.getLogs().join('\n')).toContain('voice_provider_settings_invalid');
      // Publish the canonical SavedSecret configuration again through the
      // real Account settings owner before exercising connected teardown.
      await environment.installSavedSecretSettings();
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('settles an actual denied microphone preparation and releases partial acquisition once', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    vi.spyOn(globalThis.navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('private microphone permission detail', 'NotAllowedError'),
    );
    const composed = await environment.createRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ errorCode: 'mic_permission_denied' });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(log.getLogs().join('\n')).not.toContain('private microphone permission detail');
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('preserves a safe coded resource-preflight failure without exposing its raw message', async () => {
    const machine = createMachineFixture();
    const providerPrepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const createConnection = vi.fn(async () => createConnectionFixture().connection);
    const controller = createVoiceConversationController({
      adapter: createAdapter({ prepare: providerPrepare }),
      machine: machine.machine,
      createConnection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        preflight: async () => {
          throw Object.assign(new Error('sensitive machine path: /private/workspace'), {
            code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
          });
        },
        prepare: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
    });

    await expect(controller.start({ controlSessionId: 'binding-preflight' })).resolves.toEqual({
      status: 'failed',
      code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    });
    expect(providerPrepare).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(machine.transitions).toEqual(['connecting', 'failed']);
  });

  it.each([
    'session_refresh_failed',
    'session_metadata_wait_timed_out',
    'metadata_write_rejected',
  ] as const)('preserves the bounded %s diagnostic when a coded start failure is recorded', async (reason) => {
    const machine = createMachineFixture();
    const failed = vi.fn(machine.machine.failed);
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        prepare: async () => {
          throw Object.assign(new Error('private provider or transport detail'), {
            code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
            reason,
            cause: { secret: 'must-not-be-recorded' },
          });
        },
      }),
      machine: {
        ...machine.machine,
        failed,
      },
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await expect(controller.start({ controlSessionId: `metadata-${reason}` })).resolves.toEqual({
      status: 'failed',
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
    });
    expect(failed).toHaveBeenCalledWith({
      controlSessionId: `metadata-${reason}`,
      attemptId: 1,
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      diagnosticReason: reason,
    });
  });

  it('redacts an unsafe resource-preflight error code to the generic connection failure', async () => {
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        preflight: async () => {
          throw Object.assign(new Error('private failure'), {
            code: 'machine unavailable at /Users/private/repository',
          });
        },
        prepare: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
    });

    await expect(controller.start({ controlSessionId: 'unsafe-code' })).resolves.toEqual({
      status: 'failed',
      code: 'voice_connection_failed',
    });
  });

  it.each([
    'provider preflight',
    'resource prepare',
    'provider prepare',
  ] as const)('normalizes typed %s decline codes at every controller output', async (boundary) => {
    for (const [code, expectedCode] of [
      ['machine unavailable at /Users/private/repository', 'voice_connection_failed'],
      ['VOICE_AGENT_TARGET_MACHINE_OFFLINE', 'VOICE_AGENT_TARGET_MACHINE_OFFLINE'],
    ] as const) {
      const releasePrepared = vi.fn(async () => {});
      const machine = createMachineFixture();
      const disconnected = vi.fn(machine.machine.disconnected);
      const adapter = createAdapter({
        releasePrepared,
        ...(boundary === 'provider preflight'
          ? { preflight: async () => ({ kind: 'declined' as const, code }) }
          : {}),
        ...(boundary === 'provider prepare'
          ? { prepare: async () => ({ kind: 'declined' as const, code }) }
          : {}),
      });
      const resources = boundary === 'resource prepare'
        ? {
            prepare: vi.fn(async () => ({ kind: 'declined' as const, code })),
            release: vi.fn(async () => {}),
          }
        : undefined;
      const controller = createVoiceConversationController({
        adapter,
        machine: {
          ...machine.machine,
          disconnected,
        },
        createConnection: async () => createConnectionFixture().connection,
        isSelectionCurrent: () => true,
        onCanonicalEvent: async () => {},
        resources,
      });

      await expect(controller.start({ controlSessionId: `decline-${boundary}` })).resolves.toEqual({
        status: 'declined',
        code: expectedCode,
      });
      expect(disconnected).toHaveBeenCalledWith({
        controlSessionId: `decline-${boundary}`,
        attemptId: 1,
        code: expectedCode,
      });
      expect(releasePrepared).toHaveBeenCalledWith({
        controlSessionId: `decline-${boundary}`,
        attemptId: 1,
        reason: { code: 'error', detail: expectedCode },
      });
    }
  });

  it('settles prepared, declined, and aborted starts exactly once', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    let wallClockMs = Date.now();
    let advanceAfterReceivingClockRead: number | null = null;
    // Install before activation: both the credential parser's captured clock
    // and the provider's later expiry guard observe this same physical clock.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      const observed = wallClockMs;
      if (advanceAfterReceivingClockRead !== null) {
        const next = advanceAfterReceivingClockRead;
        advanceAfterReceivingClockRead = null;
        queueMicrotask(() => { wallClockMs = next; });
      }
      return observed;
    });
    const composed = await environment.createRuntime(browser);
    const mint = deferred<void>();
    const abortMintEntered = deferred<void>();
    const states: string[] = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }, previous) => {
      if (snapshot.controlSessionId === composed.controlSessionId && snapshot.state !== previous.snapshot.state) {
        states.push(snapshot.state);
      }
    });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(states.filter(state => state === 'connected')).toHaveLength(1);
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      const firstPeer = browser.peer;
      const firstTrack = browser.micTrack;
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
      expect(firstTrack.stop).toHaveBeenCalledTimes(1);
      const respond = environment.providerFetch.getMockImplementation();
      if (!respond) throw new Error('OpenAI HTTP boundary is absent');
      const expiresAtSeconds = Math.floor(wallClockMs / 1_000) + 60;
      const expiryBoundaryMs = expiresAtSeconds * 1_000;
      environment.providerFetch.mockImplementation(async (input, init) => {
        if (!String(input).endsWith('/client_secrets')) return await respond(input, init);
        wallClockMs = expiryBoundaryMs - OPENAI_CLIENT_AUTH_EXPIRY_SAFETY_WINDOW_MS - 1;
        const payload = new TextEncoder().encode(JSON.stringify(environment.createClientAuthProviderResponse(
          'ek_preparation_expiry', expiresAtSeconds,
        )));
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(payload); controller.close(); } });
        const getReader = body.getReader.bind(body);
        vi.spyOn(body, 'getReader').mockImplementation(options => {
          const reader = getReader(options);
          if (reader instanceof ReadableStreamDefaultReader) {
            const read = reader.read.bind(reader);
            vi.spyOn(reader, 'read').mockImplementation(async () => {
              const chunk = await read();
              if (chunk.done) advanceAfterReceivingClockRead = expiryBoundaryMs;
              return chunk;
            });
          }
          return reader;
        });
        // The HTTP artifact is fresh at receipt, then the wall clock advances
        // before the provider's asynchronous preparation continuation.
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      });
      states.length = 0;
      await expect(composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null })).resolves.toBeUndefined();
      expect(states).toEqual(['connecting', 'disconnected']);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'voice_auth_expired' });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peers).toEqual([firstPeer]);
      expect(globalThis.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);

      environment.providerFetch.mockImplementation(async (input, init) => {
        if (String(input).endsWith('/client_secrets')) { abortMintEntered.resolve(); await mint.promise; }
        return await respond(input, init);
      });
      states.length = 0;
      const mintsBeforeAbort = environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets')).length;
      const aborted = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([abortMintEntered.promise, aborted]);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets')))
        .toHaveLength(mintsBeforeAbort + 1);
      const stopping = composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      mint.resolve();
      await aborted;
      await stopping;
      expect(states).toEqual(['connecting', 'ending', 'disconnected']);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peers).toEqual([firstPeer]);
      expect(globalThis.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
    } finally {
      mint.resolve();
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      clock.mockRestore();
      browser.restore();
    }
  });

  it('initializes every connected transport with the owned request before publishing connected', async () => {
    const { withGeneratedElevenLabsVoiceRuntime } = await import('@/dev/testkit/harness/elevenLabsVoiceRuntime');
    const sdkSession = createElevenLabsSdkSession('elevenlabs-prepared-context');
    const sdkNegotiation = deferred<typeof sdkSession>();
    const sdkStarted = deferred<void>();
    elevenLabsSdk.startSession.mockImplementationOnce(async () => {
      sdkStarted.resolve();
      return await sdkNegotiation.promise;
    });
    await withGeneratedElevenLabsVoiceRuntime(async ({ adapter }) => {
      const starting = adapter.start({ sessionId: '', requestedTargetSessionAddress: null,
        textOnly: true, initialContext: 'workspace context' });
      try {
        await Promise.race([sdkStarted.promise, starting]);
        expect(elevenLabsSdk.startSession).toHaveBeenCalledTimes(1);
        expect(elevenLabsSdk.startSession.mock.calls[0]?.[0]).toMatchObject({
          dynamicVariables: { initialConversationContext: 'workspace context' },
        });
        expect(adapter.getSnapshot().status).toBe('connecting');
        expect(elevenLabsSdk.sendContextualUpdate).not.toHaveBeenCalled();
        sdkNegotiation.resolve(sdkSession);
        await starting;
        expect(adapter.getSnapshot().status).toBe('connected');
        // The actual ElevenLabs preparation already placed this request into
        // SDK startup; the host must not send it again after connect.
        expect(elevenLabsSdk.sendContextualUpdate).not.toHaveBeenCalled();
        await adapter.stop({ sessionId: adapter.getSnapshot().sessionId ?? '' });
      } finally {
        sdkNegotiation.resolve(sdkSession);
        await starting;
      }
    });
    // OpenAI is a real producer of the complementary unprepared context path.
    // Its reconnect must carry the same owned request before connected too.
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const contextWire = encodeOpenAiRealtimeClientEvent({ type: 'conversation.item.create', item: {
      type: 'message', role: 'system', content: [{ type: 'input_text', text: '[Context update]\nworkspace context' }],
    } });
    let connectedPublications = 0;
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }, previous) => {
      if (snapshot.adapterId !== environment.entry.providerId || snapshot.state !== 'connected'
        || previous.snapshot.state === 'connected') return;
      expect(browser.peer.channel.sent.map(wire => JSON.parse(wire)).filter(event => (
        event.type === 'conversation.item.create' && event.item?.role === 'system'
      ))).toEqual([contextWire]);
      connectedPublications += 1;
    });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null,
        initialContext: 'workspace context' });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      const firstPeer = browser.peer;
      const ownedAttempt = composed.controller?.getOwnedAttemptId();
      expect(connectedPublications).toBe(1);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reconnecting = composed.requestReconnect();
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await Promise.race([browser.peerCreated(1).then(peer => peer.remoteDescriptionSet), reconnecting]);
      expect(browser.peers).toHaveLength(2);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
      expect(connectedPublications).toBe(1);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connecting');
      browser.peer.channel.open();
      await expect(reconnecting).resolves.toBe(true);
      expect(connectedPublications).toBe(2);
      expect(composed.controller?.getOwnedAttemptId()).toBe(ownedAttempt);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(useVoiceConversationRuntimeStore.getState().snapshot.reconnecting).toBe(false);
    } finally {
      unsubscribe();
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('reapplies a held non-active output focus state before a reconnect can play', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup));
    const firstContext = conversation.context;
    const firstConnection = conversation.getConnection();
    const duckGain = VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.duckGain;
    expect(conversation.adapter.setOutputFocusState?.({ sessionId: conversation.controlSessionId, state: 'ducked' })).toBe('applied');
    expect(firstContext.gain.setTargetAtTime).toHaveBeenLastCalledWith(duckGain, firstContext.currentTime, 0.015);
    await conversation.startOutput();
    const oldOutput = firstContext.sources.at(-1)!;
    const focusCallsBeforeReconnect = firstContext.gain.setTargetAtTime.mock.calls.length;
    const openGate = conversation.sdk.holdNextOpen();
    try {
      const reconnecting = conversation.requestReconnect();
      await Promise.race([openGate.entered, reconnecting]);
      expect(conversation.sdk.openCount).toBe(2);
      // A reconnect replaces the PCM connection/scheduler, not the attempt's
      // mic-owned AudioContext. The new scheduler must start with held focus.
      expect(firstConnection?.state()).toBe('closed');
      expect(conversation.getConnection()).not.toBe(firstConnection);
      expect(oldOutput.stop).toHaveBeenCalledTimes(1);
      expect(firstContext.disconnectGain).toHaveBeenCalledTimes(1);
      expect(firstContext.close).not.toHaveBeenCalled();
      expect(conversation.context).toBe(firstContext);
      expect(firstContext.gain.setTargetAtTime.mock.calls.slice(focusCallsBeforeReconnect)[0]?.[0]).toBe(duckGain);
      expect(conversation.getConnection()?.state()).toBe('connecting');
      openGate.release();
      await expect(reconnecting).resolves.toBe(true);
      await conversation.startOutput();
      expect(conversation.context.gain.setTargetAtTime).toHaveBeenLastCalledWith(duckGain, conversation.context.currentTime, 0.015);
    } finally {
      openGate.release();
    }
  });

  it.each([
    {
      failure: 'ordinary provider rejection',
      error: new Error('provider_unreachable'),
      expectedCode: 'voice_connection_failed',
    },
    {
      failure: 'transport-originated abort-shaped rejection while the attempt remains live',
      error: Object.assign(new Error('voice_webrtc_ice_failed'), {
        name: 'AbortError',
        code: 'voice_webrtc_ice_failed',
      }),
      expectedCode: 'voice_webrtc_ice_failed',
    },
  ])('keeps $failure controller-visible with its safe code and releases ownership', async ({
    error,
    expectedCode,
  }) => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup), { autoStart: false });
    const states: string[] = [];
    machineSubscriptions.push(useVoiceConversationRuntimeStore.subscribe(({ snapshot }, previous) => {
      if (snapshot.controlSessionId === conversation.controlSessionId && snapshot.state !== previous.snapshot.state) states.push(snapshot.state);
    }));
    const openGate = conversation.sdk.holdNextOpen();
    try {
      const starting = conversation.adapter.start({ sessionId: '', requestedTargetSessionAddress: null }).catch((failure: unknown) => failure);
      await Promise.race([openGate.entered, starting]);
      expect(conversation.sdk.openCount).toBe(1);
      expect(conversation.getController().getOwnedControlSessionId()).toBe(conversation.controlSessionId);
      openGate.reject(error);
      await expect(starting).resolves.toMatchObject({ code: expectedCode });
      expect(conversation.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: expectedCode });
      expect(conversation.getController().getOwnedControlSessionId()).toBeNull();
      expect(conversation.getConnection()?.state()).toBe('closed');
      expect(conversation.context.close).toHaveBeenCalledTimes(1);
      expect(states[0]).toBe('connecting');
      expect(states.at(-1)).toBe('error');
      expect(states).not.toContain('connected');
    } finally {
      openGate.release();
    }
  });

  it.each([
    'voice_webrtc_control_malformed',
    'voice_connection_inbound_overflow',
  ])('fails closed for non-transport %s when the owned WebRTC event queue terminates', async (failureCode) => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      if (failureCode === 'voice_webrtc_control_malformed') {
        browser.peer.channel.message('not a JSON control frame');
      } else {
        // The actual WebRTC owner's default queue admits 256 waiting controls.
        // One additional frame satisfies its pending read; the next overflows.
        const controlQueueCapacity = 256;
        for (let index = 0; index < controlQueueCapacity + 2 && browser.peer.channel.readyState === 'open'; index += 1) {
          browser.peer.channel.message(JSON.stringify({ type: 'input_audio_buffer.speech_started', event_id: `queued-${index}` }));
        }
      }
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().errorCode, code => code === failureCode);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: failureCode });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(browser.peer.createDataChannel).toHaveBeenCalledTimes(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('bounds an initial connection that never becomes ready and releases ownership', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null }).catch((error: unknown) => error);
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      expect(composed.controller?.getOwnedControlSessionId()).toBe(composed.controlSessionId);
      // The physical channel never opens. Use the canonical connection owner's
      // full budget, not an independently authored shorter test timeout.
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.connectionReadyTimeoutMs);
      await expect(starting).resolves.toMatchObject({ code: 'voice_connection_timeout' });
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'voice_connection_timeout' });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('keeps an explicit stop authoritative when an abort-ignoring connection later times out', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const signaling = deferred<void>();
    const signalingEntered = deferred<void>();
    const respond = environment.providerFetch.getMockImplementation();
    if (!respond) throw new Error('OpenAI HTTP boundary is absent');
    environment.providerFetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/calls')) { signalingEntered.resolve(); await signaling.promise; }
      return await respond(...args);
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([signalingEntered.promise, starting]);
      expect(environment.providerFetch.mock.calls.some(([url]) => String(url).endsWith('/calls'))).toBe(true);
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      signaling.resolve();
      await starting;
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.connectionReadyTimeoutMs);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('disconnected');
      expect(browser.peer.setRemoteDescription).not.toHaveBeenCalled();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
    } finally {
      signaling.resolve();
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('releases provider preparation state when a prepared connection never becomes active', async () => {
    const releasePrepared = vi.fn(async () => {});
    const connection = createConnectionFixture();
    connection.connect.mockImplementation(async () => {
      throw new Error('missing_provider_identity');
    });
    const adapter = Object.assign(createAdapter(), { releasePrepared }) as VoiceRealtimeProtocolAdapter;
    const controller = createVoiceConversationController({
      adapter,
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await controller.start({ controlSessionId: 'prepared-but-not-active' });
    expect(releasePrepared).toHaveBeenCalledTimes(1);
    expect(releasePrepared).toHaveBeenCalledWith({
      controlSessionId: 'prepared-but-not-active',
      attemptId: 1,
      reason: { code: 'error' },
    });
  });

  it('releases ownership before publishing a terminal machine settlement', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const voice = environment.persistedAccountSettings.voiceSettingsV1;
    const providerId = environment.entry.providerId;
    await environment.configureVoice({ ...voice, providers: { ...voice.providers,
      [providerId]: { schemaVersion: 1, config: { ...readVoiceProviderSettingsConfig(voice, providerId), turnDetection: 'not-a-turn-mode' } },
    } });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const observedOwnership: Array<string | null> = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => {
      if (snapshot.controlSessionId === composed.controlSessionId && snapshot.error?.reason === 'voice_provider_settings_invalid') {
        observedOwnership.push(composed.controller?.getOwnedControlSessionId() ?? null);
      }
    });
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(observedOwnership).toEqual([null]);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('makes stale preparation inert and closes the original connection on stop during connect', async () => {
    const firstPreparation = deferred<Awaited<ReturnType<VoiceRealtimeProtocolAdapter['prepare']>>>();
    const connectGate = deferred<void>();
    const firstConnection = createConnectionFixture('sdk_handle');
    firstConnection.connect.mockImplementation(async () => await connectGate.promise);
    const secondConnection = createConnectionFixture();
    const machine = createMachineFixture();
    let prepareCount = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        prepare: async () => {
          prepareCount += 1;
          return prepareCount === 1
            ? await firstPreparation.promise
            : { kind: 'prepared', session: { config: {}, safeMetadata: null } };
        },
      }),
      machine: machine.machine,
      createConnection: async (_session, attempt) => attempt === 1
        ? firstConnection.connection
        : secondConnection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    const staleStart = controller.start({ controlSessionId: 'stale' });
    const liveStart = controller.start({ controlSessionId: 'live' });
    firstPreparation.resolve({ kind: 'prepared', session: { config: {}, safeMetadata: null } });
    await expect(staleStart).resolves.toEqual({ status: 'aborted' });
    await expect(liveStart).resolves.toEqual({ status: 'connected' });
    expect(firstConnection.connect).not.toHaveBeenCalled();

    const connectingController = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => firstConnection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    const connecting = connectingController.start({ controlSessionId: 'during-connect' });
    await Promise.race([firstConnection.connectEntered, connecting]);
    expect(firstConnection.connect).toHaveBeenCalled();
    const stopping = connectingController.stop();
    connectGate.resolve();
    await expect(connecting).resolves.toEqual({ status: 'aborted' });
    await stopping;
    expect(firstConnection.close).toHaveBeenCalledTimes(1);
  });

  it('settles stopped A before same-session replacement B takes ownership', async () => {
    const closeGate = deferred<void>();
    const closeEntered = deferred<void>();
    ownedRuntimeCleanups.push(async () => { closeGate.resolve(); });
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup));
    const firstContext = conversation.context;
    const firstConnection = conversation.getConnection();
    firstContext.close.mockImplementation(async () => { closeEntered.resolve(); await closeGate.promise; });
    const controller = conversation.getController();
    let stopped = false;
    const stopping = conversation.adapter.stop({ sessionId: conversation.controlSessionId }).then(() => { stopped = true; });
    try {
      await Promise.race([closeEntered.promise, stopping]);
      expect(firstContext.close).toHaveBeenCalledTimes(1);
      const replacement = conversation.adapter.start({ sessionId: conversation.controlSessionId, requestedTargetSessionAddress: null });
      await Promise.resolve();
      expect(conversation.sdk.openCount).toBe(1);
      expect(stopped).toBe(false);
      closeGate.resolve();
      await replacement;
      expect(controller.getOwnedControlSessionId()).toBe(conversation.controlSessionId);
      expect(controller.getOwnedAttemptId()).toBe(2);
      expect(firstConnection?.state()).toBe('closed');
      expect(conversation.sdk.openCount).toBe(2);
      expect(conversation.context).not.toBe(firstContext);
      expect(conversation.context.close).not.toHaveBeenCalled();
      expect(conversation.adapter.getSnapshot().status).toBe('connected');
      await stopping;
      expect(controller.getOwnedAttemptId()).toBe(2);
      expect(controller.getOwnedControlSessionId()).toBe(conversation.controlSessionId);
      expect(conversation.adapter.getSnapshot().status).toBe('connected');
      await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
      expect(conversation.context.close).toHaveBeenCalledTimes(1);
      expect(controller.getOwnedAttemptId()).toBeNull();
    } finally {
      closeGate.resolve();
      await stopping;
    }
  });

  it('settles failed A before same-session replacement B takes ownership', async () => {
    const closeGate = deferred<void>();
    const closeEntered = deferred<void>();
    ownedRuntimeCleanups.push(async () => { closeGate.resolve(); });
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup));
    const firstContext = conversation.context;
    const firstConnection = conversation.getConnection();
    const firstTrack = conversation.browser.micTrack;
    firstContext.close.mockImplementation(async () => { closeEntered.resolve(); await closeGate.promise; });
    firstTrack.dispatchEvent(new Event('ended'));
    try {
      await closeEntered.promise;
      expect(firstContext.close).toHaveBeenCalledTimes(1);
      const replacement = conversation.adapter.start({ sessionId: conversation.controlSessionId, requestedTargetSessionAddress: null });
      await Promise.resolve();
      expect(conversation.sdk.openCount).toBe(1);
      closeGate.resolve();
      await replacement;
      expect(conversation.getController().getOwnedControlSessionId()).toBe(conversation.controlSessionId);
      expect(conversation.getController().getOwnedAttemptId()).toBe(2);
      expect(firstConnection?.state()).toBe('closed');
      expect(conversation.sdk.openCount).toBe(2);
      expect(conversation.context).not.toBe(firstContext);
      expect(conversation.browser.micTrack).not.toBe(firstTrack);
      expect(conversation.browser.micTrack.readyState).toBe('live');
      expect(conversation.context.close).not.toHaveBeenCalled();
      expect(conversation.adapter.getSnapshot().status).toBe('connected');
      await conversation.startOutput();
      expect(conversation.context.sources[0]?.start).toHaveBeenCalled();
      expect(conversation.adapter.getSnapshot().status).toBe('connected');
    } finally {
      closeGate.resolve();
    }
  });

  it('keeps A cancelled when replacement B fails selection before A settles late', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const voice = storage.getState().settings.voiceSettingsV1;
    const publishSelection = (providerId: string) => {
      const current = storage.getState().settings;
      storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
        voiceSettingsV1: { ...voice, providerId },
      }, current));
    };
    const states: string[] = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => {
      if (snapshot.controlSessionId === composed.controlSessionId) states.push(snapshot.state);
    });
    try {
      let firstSettled = false;
      const first = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null }).then(() => { firstSettled = true; });
      const stopping = composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      publishSelection('off');
      const replacement = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      expect(firstSettled).toBe(false);
      await replacement;
      expect(log.getLogs().join('\n')).toContain('voice_provider_not_selected');
      publishSelection(environment.entry.providerId);
      await stopping;
      await first;
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(environment.providerFetch).not.toHaveBeenCalled();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      expect(states).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).toBe('disconnected');
    } finally {
      unsubscribe();
      publishSelection(environment.entry.providerId);
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('fences a real provider selection change while OpenAI credentials are being minted', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const mint = deferred<void>();
    const mintEntered = deferred<void>();
    const respond = environment.providerFetch.getMockImplementation();
    if (!respond) throw new Error('OpenAI HTTP boundary unavailable');
    environment.providerFetch.mockImplementation(async (...args) => {
      mintEntered.resolve();
      await mint.promise;
      return await respond(...args);
    });
    const composed = await environment.createRuntime(browser);
    const statuses: string[] = [];
    const unsubscribe = composed.runtime.adapter.subscribe?.(() => {
      statuses.push(composed.runtime.adapter.getSnapshot().status);
    }) ?? (() => {});
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([mintEntered.promise, starting]);
      expect(environment.providerFetch).toHaveBeenCalledOnce();
      await environment.configureVoice({ ...environment.persistedAccountSettings.voiceSettingsV1, providerId: 'off' });
      mint.resolve();
      await starting;
      expect(statuses).not.toContain('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connecting');
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      const failures: unknown[] = log.getLogs().filter(line => line.startsWith('[voiceRuntimeFailure] '))
        .map(line => JSON.parse(line.slice(line.indexOf('{'))));
      expect(failures).toContainEqual(expect.objectContaining({
        kind: 'aborted', reason: 'voice_start_not_settled',
      }));
    } finally {
      mint.resolve();
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('gates turn actions on semantic capability and forwards canonical events', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const controller = composed.controller;
      if (!controller) throw new Error('Actual OpenAI controller is absent');
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      browser.peer.channel.message(JSON.stringify({ type: 'input_audio_buffer.speech_started', event_id: 'speech-controls' }));
      browser.peer.channel.message(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'controls-transcript', item_id: 'controls-transcript', transcript: 'canonical controls remain usable',
      }));
      await waitForTestEvent(storage.subscribe, () => readCanonicalVoiceTranscriptSnapshot(composed.historySessionId), entries => entries.some(entry => entry.text === 'canonical controls remain usable'));
      expect(readCanonicalVoiceTranscriptSnapshot(composed.historySessionId)).toEqual([
        expect.objectContaining({ role: 'user', text: 'canonical controls remain usable' }),
      ]);
      const sentBeforeAction = browser.peer.channel.sent.length;
      await expect(controller.performTurnControl('cancel_response')).resolves.toEqual({ status: 'sent' });
      await expect(controller.performTurnControl('send_exact_message')).resolves.toEqual({
        status: 'unavailable', code: 'voice_turn_action_unsupported',
      });
      expect(browser.peer.channel.sent.slice(sentBeforeAction).map(wire => JSON.parse(wire))).toEqual([
        { type: 'response.cancel' },
      ]);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it.each([true, false])('submits admitted Manual input and requests a response while keeping its connection open (%s)', async (inputCommitRequired) => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const voice = environment.persistedAccountSettings.voiceSettingsV1;
    const providerId = environment.entry.providerId;
    await environment.configureVoice({ ...voice, providers: { ...voice.providers,
      [providerId]: { schemaVersion: 1, config: { ...readVoiceProviderSettingsConfig(voice, providerId),
        turnDetection: inputCommitRequired ? 'manual' : 'server_vad',
      } },
    } });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const controller = composed.controller;
      if (!controller) throw new Error('Actual OpenAI controller is absent');
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      const sentBeforeCommit = browser.peer.channel.sent.length;
      expect(controller.canCommitInput()).toBe(inputCommitRequired);
      expect(composed.runtime.adapter.getSnapshot().canCommitInput).toBe(inputCommitRequired);
      expect(await controller.performTurnControl('commit_input')).toEqual(inputCommitRequired
        ? { status: 'sent' } : { status: 'unavailable', code: 'voice_turn_action_unsupported' });
      expect(browser.peer.channel.sent.slice(sentBeforeCommit).map(wire => JSON.parse(wire))).toEqual(inputCommitRequired ? [
        { type: 'input_audio_buffer.commit' }, { type: 'response.create' },
      ] : []);
      if (inputCommitRequired) {
        await composed.runtime.adapter.commitInput?.({ sessionId: composed.controlSessionId });
        expect(browser.peer.channel.sent.slice(sentBeforeCommit + 2).map(wire => JSON.parse(wire))).toEqual([
          { type: 'input_audio_buffer.commit' }, { type: 'response.create' },
        ]);
      }
      expect(browser.peer.close).not.toHaveBeenCalled();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(controller.canCommitInput()).toBe(false);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('does not advertise hold from Manual commit alone', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup), {
      inputCommitRequired: true,
    });
    const controller = conversation.getController();
    expect(controller.canCommitInput()).toBe(true);
    expect(controller.canHoldToTalk()).toBe(false);
    expect(conversation.adapter.getSnapshot()).toMatchObject({ canCommitInput: true, canHoldToTalk: false });
    const sentBeforeAdmission = conversation.sent.length;
    expect(controller.beginHoldToTalk()).toBeNull();
    expect(conversation.sent).toHaveLength(sentBeforeAdmission);
    await conversation.adapter.commitInput?.({ sessionId: conversation.controlSessionId });
    expect(conversation.sent.slice(sentBeforeAdmission)).toEqual([{ kind: 'input.commit' }, { kind: 'continue' }]);
    expect(conversation.adapter.getSnapshot().status).toBe('connected');
    expect(conversation.context.close).not.toHaveBeenCalled();
    expect(conversation.browser.micTrack.readyState).toBe('live');
    await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
    expect(controller.canCommitInput()).toBe(false);
    expect(conversation.context.close).toHaveBeenCalledTimes(1);
  });

  it('does not create a response after End Voice retires an in-flight input commit', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const voice = environment.persistedAccountSettings.voiceSettingsV1;
    await environment.configureVoice({ ...voice, providers: { ...voice.providers,
      [environment.entry.providerId]: { schemaVersion: 1, config: {
        ...readVoiceProviderSettingsConfig(voice, environment.entry.providerId), turnDetection: 'manual',
      } },
    } });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const controller = composed.controller;
      if (!controller) throw new Error('Actual OpenAI controller is absent');
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      const sentBeforeCommit = browser.peer.channel.sent.length;
      const commit = JSON.stringify({ type: 'input_audio_buffer.commit' });
      browser.peer.channel.bufferedAmount = VOICE_WEBRTC_LIMITS.outboundBufferedBytes - new TextEncoder().encode(commit).byteLength;
      const submitting = controller.performTurnControl('commit_input').catch((error: unknown) => error);
      await waitForTestEvent(browser.peer.channel.subscribe, () => {
        expect(browser.peer.channel.sent.slice(sentBeforeCommit).map(wire => JSON.parse(wire))).toEqual([
          { type: 'input_audio_buffer.commit' },
        ]);
        // The default zero threshold also satisfies the comparison below.
        // Observe the real response-send capacity wait, not only commit.send.
        expect(browser.peer.channel.bufferedAmountLowThreshold).toBeGreaterThan(0);
        expect(browser.peer.channel.bufferedAmountLowThreshold).toBeLessThan(browser.peer.channel.bufferedAmount);
      });
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      browser.peer.channel.drainTo(0);
      await expect(submitting).resolves.toMatchObject({ name: 'AbortError' });
      expect(browser.peer.channel.sent.slice(sentBeforeCommit).map(wire => JSON.parse(wire))).toEqual([
        { type: 'input_audio_buffer.commit' },
      ]);
      expect(controller.getOwnedControlSessionId()).toBeNull();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('exposes provider-encoded client controls only while the owned connection is open', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const controller = composed.controller;
      if (!controller) throw new Error('Actual OpenAI controller is absent');
      const event = encodeOpenAiRealtimeClientEvent({ type: 'conversation.item.create', item: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }],
      } });
      await expect(controller.sendClientControl(event)).resolves.toEqual({
        status: 'unavailable', code: 'voice_connection_not_open',
      });
      expect(browser.peers).toHaveLength(0);
      expect(globalThis.RTCPeerConnection).not.toHaveBeenCalled();
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      const sentBeforeText = browser.peer.channel.sent.length;
      await expect(controller.sendClientControl(event)).resolves.toEqual({ status: 'sent' });
      expect(controller.getActiveControlSessionId()).toBe(composed.controlSessionId);
      expect(browser.peer.channel.sent.slice(sentBeforeText).map(wire => JSON.parse(wire))).toEqual([event]);
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      await expect(controller.sendClientControl(event)).resolves.toEqual({
        status: 'unavailable', code: 'voice_connection_not_open',
      });
      expect(browser.peer.channel.sent).toHaveLength(sentBeforeText + 1);
      expect(controller.getActiveControlSessionId()).toBeNull();
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('makes stop idempotent and prevents stale event side effects after teardown', async () => {
    const connection = createConnectionFixture();
    const machine = createMachineFixture();
    const onCanonicalEvent = vi.fn(async () => {});
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent,
    });
    await controller.start({ controlSessionId: 'stop' });
    await controller.stop();
    await controller.stop();
    connection.events.push({ type: 'late' });
    connection.finishEvents();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(machine.transitions).toEqual(['connecting', 'connected', 'ending', 'disconnected']);
    expect(onCanonicalEvent).not.toHaveBeenCalled();
  });

  it('settles a real microphone track ending once while releasing owned resources', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      browser.micTrack.dispatchEvent(new Event('ended'));
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => expect(composed.hostLease.host.machine.getSnapshot()).toMatchObject({ error: { reason: 'mic_ended' } }));
      expect(composed.hostLease.host.machine.getSnapshot()).toMatchObject({
        state: 'error', error: { kind: 'mic_ended', reason: 'mic_ended' },
      });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      browser.micTrack.dispatchEvent(new Event('ended'));
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(composed.hostLease.host.machine.getSnapshot()).toMatchObject({
        state: 'error', error: { kind: 'mic_ended', reason: 'mic_ended' },
      });
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('retries transient preparation failures through cancellable reconnect backoff', async () => {
    const { readVoiceProviderConversationMetadata } = await import('@/voice/persistence/voiceProviderConversationMetadata');
    const environment = await createXaiVoiceRuntimeEnvironment();
    await environment.installSettings(true);
    const composed = await environment.createRuntime();
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      const first = environment.physicalSockets[0]!;
      first.emitConversationId('conv-preparation-retry');
      await waitForTestEvent(storage.subscribe, () => readVoiceProviderConversationMetadata(environment.readProviderConversationOwnerMetadata(environment.historySessionId), environment.xaiEntry().providerId)?.conversationId, id => id === 'conv-preparation-retry');
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(environment.historySessionId), environment.xaiEntry().providerId,
      )?.conversationId).toBe('conv-preparation-retry');
      const attemptId = composed.getController().getOwnedAttemptId();
      const respond = composed.providerFetch.getMockImplementation();
      if (!respond) throw new Error('xAI HTTP boundary is absent');
      let failedMints = 0;
      composed.providerFetch.mockImplementation(async (input, init) => {
        if (failedMints === 0 && String(input).endsWith('/v1/realtime/client_secrets')) {
          failedMints += 1;
          return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
        }
        return await respond(input, init);
      });
      const mintCount = () => composed.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets')).length;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reconnecting = composed.requestReconnect();
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => ({ failedMints, mints: mintCount(), retry: composed.runtime.adapter.getSnapshot().reconnectRetryAvailable }), value => value.failedMints === 1 && value.mints === 2 && value.retry === true);
      expect(failedMints).toBe(1);
      expect(mintCount()).toBe(2);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      // A failed real credential preparation consumes slot one without
      // allocating a replacement SDK carrier or releasing the attempt.
      expect(environment.physicalSockets).toHaveLength(1);
      expect(first.readyState).toBe(3);
      expect(composed.getController().getOwnedAttemptId()).toBe(attemptId);
      expect(composed.getController().getOwnedControlSessionId()).toBe(composed.controlSessionId);
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('error');
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs
        * VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.backoffFactor);
      await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => expect(environment.physicalSockets).toHaveLength(2));
      await vi.advanceTimersToNextTimerAsync();
      await expect(reconnecting).resolves.toBe(true);
      expect(environment.physicalSockets).toHaveLength(2);
      expect(mintCount()).toBe(3);
      expect(new URL(environment.physicalSockets[1]!.url).searchParams.get('conversation_id')).toBe('conv-preparation-retry');
      expect(environment.physicalSockets[1]!.readyState).toBe(1);
      expect(composed.getController().getOwnedAttemptId()).toBe(attemptId);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected' });
      expect(useVoiceConversationRuntimeStore.getState().snapshot.reconnecting).toBe(false);
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(composed.getController().getOwnedControlSessionId()).toBeNull();
      expect(environment.physicalSockets[1]!.readyState).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
      await composed.dispose();
      await environment.dispose();
    }
  });

  it('settles a typed preparation decline during reconnect without retrying it', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const respond = environment.providerFetch.getMockImplementation();
    if (!respond) throw new Error('OpenAI HTTP boundary is absent');
    let admittedExpiresAtMs: number | null = null;
    environment.providerFetch.mockImplementation(async (...args) => {
      const response = await respond(...args);
      if (String(args[0]).endsWith('/client_secrets')) {
        const artifact: unknown = await response.clone().json();
        if (!artifact || typeof artifact !== 'object' || !('expires_at' in artifact)
          || typeof artifact.expires_at !== 'number') throw new Error('Native OpenAI auth artifact has no expiry');
        admittedExpiresAtMs = artifact.expires_at * 1_000;
      }
      return response;
    });
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      if (admittedExpiresAtMs === null) throw new Error('Actual OpenAI preparation did not admit client authority');
      vi.spyOn(Date, 'now').mockReturnValue(admittedExpiresAtMs);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const reconnecting = composed.requestReconnect();
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot().reconnecting, value => value === true);
      expect(createVoiceConversationRuntimeMachine().getSnapshot().reconnecting).toBe(true);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await expect(reconnecting).resolves.toBe(false);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'voice_auth_expired' });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peers).toHaveLength(1);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('routes a terminal WebRTC event-queue loss through the shared reconnect owner', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      const firstPeer = browser.peer;
      const attemptId = composed.controller?.getOwnedAttemptId();
      firstPeer.channel.close();
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot().reconnecting, value => value === true);
      expect(createVoiceConversationRuntimeMachine().getSnapshot().reconnecting).toBe(true);
      expect(browser.peers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await browser.peerCreated(1).then(peer => peer.remoteDescriptionSet);
      expect(browser.peers).toHaveLength(2);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      expect(browser.peer).not.toBe(firstPeer);
      browser.peer.channel.open();
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot(), snapshot => snapshot.state === 'connected' && !snapshot.reconnecting);
      expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'connected', reconnecting: false });
      expect(composed.controller?.getOwnedAttemptId()).toBe(attemptId);
      expect(composed.controller?.getActiveControlSessionId()).toBe(composed.controlSessionId);
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected' });
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('fences a received old-carrier identity queued behind a held metadata acknowledgment before reconnect', async () => {
    const environment = await createXaiVoiceRuntimeEnvironment();
    await environment.installSettings(true);
    const composed = await environment.createRuntime();
    const { SessionCurrentProjectionRecordV1Schema, projectSessionOwnerCompatibilityViewV1 } = await import('@happier-dev/protocol');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { readVoiceProviderConversationMetadata } = await import('@/voice/persistence/voiceProviderConversationMetadata');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const readPersistedCarrier = async () => {
      const response = environment.sessionHttp.handle(
        `${getActiveServerSnapshot().serverUrl}/v2/sessions/${encodeURIComponent(environment.historySessionId)}`,
      );
      if (!response?.ok) throw new Error('xAI history carrier HTTP boundary unavailable');
      const carrier = SessionCurrentProjectionRecordV1Schema.parse((await response.json()).session);
      if (carrier.encryptionMode !== 'plain' || carrier.ownerMetadata?.t !== 'plain' || typeof carrier.metadata !== 'string') {
        throw new Error('Expected the admitted plain Account history carrier');
      }
      return {
        carrier,
        state: readVoiceProviderConversationMetadata(projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: JSON.parse(carrier.metadata), ownerMetadata: carrier.ownerMetadata.v,
        }), environment.xaiEntry().providerId),
      };
    };
    const releaseMetadataAck = deferred<void>();
    const metadataAckEntered = deferred<void>();
    const replacementMetadataWritten = deferred<void>();
    let heldMetadataAck = false;
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      const handle = environment.sessionHttp.handle.bind(environment.sessionHttp);
      vi.spyOn(environment.sessionHttp, 'handle').mockImplementation((input, init) => {
        const response = handle(input, init);
        if (heldMetadataAck && response?.ok && init?.method === 'PATCH'
          && new URL(String(input)).pathname === `/v2/sessions/${encodeURIComponent(environment.historySessionId)}`) replacementMetadataWritten.resolve();
        if (heldMetadataAck || !response?.ok || init?.method !== 'PATCH'
          || new URL(String(input)).pathname !== `/v2/sessions/${encodeURIComponent(environment.historySessionId)}`) {
          return response;
        }
        heldMetadataAck = true;
        metadataAckEntered.resolve();
        // The real server fixture has committed the canonical producer's
        // metadata. Delay only delivery of its genuine Fetch response body.
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const body = await response.text();
              await releaseMetadataAck.promise;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        }), { status: response.status, headers: response.headers });
      });
      const first = environment.physicalSockets[0]!;
      expect(first.readyState).toBe(1);
      first.emitConversationId('conv-delayed-first');
      await metadataAckEntered.promise;
      expect(heldMetadataAck, 'actual provider identity metadata PATCH admitted').toBe(true);
      expect((await readPersistedCarrier()).state?.conversationId).toBe('conv-delayed-first');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // Both messages reach the actual driver while OPEN. The second write
      // waits in the canonical provider-conversation owner's mutation queue.
      first.emitConversationId('stale-queued-first');
      await vi.advanceTimersByTimeAsync(0);
      const reconnecting = composed.requestReconnect();
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      expect(first.readyState).toBe(3);
      expect(environment.physicalSockets).toHaveLength(1);
      expect(composed.getController().getOwnedControlSessionId()).toBe(composed.controlSessionId);
      releaseMetadataAck.resolve();
      await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => expect(environment.physicalSockets).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(0);
      await expect(reconnecting).resolves.toBe(true);
      expect(environment.physicalSockets, 'replacement SDK socket opens after actual prior metadata ACK').toHaveLength(2);
      const second = environment.physicalSockets[1]!;
      expect(new URL(second.url).searchParams.get('conversation_id')).toBe('conv-delayed-first');
      const currentIdentityReceived = deferred<void>();
      second.addEventListener('message', () => currentIdentityReceived.resolve());
      second.emitConversationId('conv-owned-second');
      await vi.advanceTimersByTimeAsync(0);
      await currentIdentityReceived.promise;
      const boundConversation = voiceSessionBindingStore.getState().getByControlSessionId(composed.controlSessionId);
      expect(first.readyState).toBe(3);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      await replacementMetadataWritten.promise;
      expect((await readPersistedCarrier()).state?.conversationId).toBe('conv-owned-second');
      await waitForTestEvent(storage.subscribe, () => readVoiceProviderConversationMetadata(environment.readProviderConversationOwnerMetadata(environment.historySessionId), environment.xaiEntry().providerId)?.conversationId, id => id === 'conv-owned-second');
      expect(readVoiceProviderConversationMetadata(
        environment.readProviderConversationOwnerMetadata(environment.historySessionId), environment.xaiEntry().providerId,
      )?.conversationId).toBe('conv-owned-second');
      expect(voiceSessionBindingStore.getState().getByControlSessionId(composed.controlSessionId)).toEqual(boundConversation);
      expect(boundConversation?.conversationSessionId).toBe(environment.historySessionId);
      expect(composed.getController().getOwnedControlSessionId()).toBe(composed.controlSessionId);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
    } finally {
      releaseMetadataAck.resolve();
      vi.useRealTimers();
      await composed.dispose();
      await environment.dispose();
      vi.restoreAllMocks();
    }
  });

  it('retains cancellable reconnect backoff across repeated failures and lets a fresh Start supersede it', async () => {
    const { createPublicPcmVoiceConversationForTest } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
    const conversation = await createPublicPcmVoiceConversationForTest(cleanup => ownedRuntimeCleanups.push(cleanup));
    const firstContext = conversation.context;
    const firstAttempt = conversation.getController().getOwnedAttemptId();
    const budget = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;
    // Six physical failures cross the removed five-attempt cutoff. The contract
    // is continued, paced recovery until End or a fresh Start, not a new budget.
    const gates = Array.from({ length: 6 }, () => conversation.sdk.holdNextOpen());
    const expectEndAvailable = () => {
      const snapshot = conversation.adapter.getSnapshot();
      expect(resolveVoiceAttemptControl({
        ...snapshot,
        surfaceState: resolveVoiceSurfaceState(snapshot),
        tone: 'neutral',
        muted: snapshot.micMuted === true,
        capturing: false,
        startAdmitted: true,
        hasRecovery: true,
      })).toMatchObject({ canStop: true, primaryAction: 'end', surfaceState: 'reconnecting' });
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reconnecting = conversation.requestReconnect();
      for (const [index, gate] of gates.entries()) {
        const slot = index + 1;
        await waitForTestEvent(conversation.adapter.subscribe!, () => conversation.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
        expect(conversation.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
        await vi.advanceTimersByTimeAsync(Math.min(budget.maxBackoffMs,
          budget.baseBackoffMs * budget.backoffFactor ** (slot - 1)));
        expectEndAvailable();
        await Promise.race([gate.entered, reconnecting]);
        expect(conversation.sdk.openCount).toBe(slot + 1);
        expect(conversation.getController().getOwnedAttemptId()).toBe(firstAttempt);
        gate.reject(new Error('offline'));
        await Promise.race([
          waitForTestEvent(conversation.adapter.subscribe!, () => conversation.adapter.getSnapshot().reconnectRetryAvailable, value => value === true),
          reconnecting,
        ]);
        expect(conversation.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
        expectEndAvailable();
      }

      // Fresh admission includes real async preparation; only reconnect
      // backoff belongs to this test's fake clock.
      vi.useRealTimers();
      await conversation.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await expect(reconnecting).resolves.toBe(false);
      expect(conversation.getController().getOwnedAttemptId()).not.toBe(firstAttempt);
      expect(conversation.adapter.getSnapshot().status).toBe('connected');
      expect(firstContext.close).toHaveBeenCalledTimes(1);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const secondContext = conversation.context;
      const secondConnection = conversation.getConnection();
      expect(secondContext).not.toBe(firstContext);
      const opensBeforePendingSlot = conversation.sdk.openCount;
      const pendingReconnect = conversation.requestReconnect();
      await waitForTestEvent(conversation.adapter.subscribe!, () => conversation.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(conversation.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      expectEndAvailable();
      expect(secondConnection?.state()).toBe('closed');
      await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
      await expect(pendingReconnect).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(budget.baseBackoffMs);
      expect(conversation.sdk.openCount).toBe(opensBeforePendingSlot);
      expect(conversation.getController().getOwnedControlSessionId()).toBeNull();
      expect(conversation.adapter.getSnapshot().status).toBe('disconnected');
      expect(conversation.adapter.getSnapshot().reconnectRetryAvailable).toBeUndefined();
      expect(secondContext.close).toHaveBeenCalledTimes(1);
      await conversation.adapter.stop({ sessionId: conversation.controlSessionId });
      expect(secondContext.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Retry to consume the pending reconnect slot without duplicating it', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    let physicalPeerCount = 0;
    const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer(peer) {
      physicalPeerCount += 1;
      if (physicalPeerCount === 2) peer.createOffer.mockRejectedValueOnce(new Error('offline'));
    } });
    const composed = await environment.createRuntime(browser);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      const attemptId = composed.controller?.getOwnedAttemptId();
      browser.peer.iceConnectionState = 'failed';
      browser.peer.dispatchEvent(new Event('iceconnectionstatechange'));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      expect(browser.peers).toHaveLength(1);
      // Retry expedites the already pending slot; the next native offer fails
      // and the canonical owner leaves slot two waiting, rather than launching
      // a third carrier or replacing this attempt.
      const retry = composed.requestReconnect();
      await browser.peerCreated(1).then(peer => peer.closed);
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(browser.peers).toHaveLength(2);
      expect(browser.peer.createOffer).toHaveBeenCalledTimes(1);
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      expect(composed.controller?.getOwnedAttemptId()).toBe(attemptId);
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('error');
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      await expect(retry).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs
        * VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.backoffFactor);
      expect(browser.peers).toHaveLength(2);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(composed.runtime.adapter.getSnapshot().status).toBe('disconnected');
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBeUndefined();
      await expect(composed.requestReconnect()).resolves.toBe(false);
      expect(browser.peers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('settles disconnected when provider selection changes during reconnect backoff', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const voice = storage.getState().settings.voiceSettingsV1;
    const publishSelection = (providerId: string) => {
      const current = storage.getState().settings;
      storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voiceSettingsV1: { ...voice, providerId } }, current));
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      const reconnecting = composed.requestReconnect();
      await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, () => createVoiceConversationRuntimeMachine().getSnapshot().reconnecting, value => value === true);
      expect(createVoiceConversationRuntimeMachine().getSnapshot().reconnecting).toBe(true);
      publishSelection('off');
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await expect(reconnecting).resolves.toBe(false);
      expect(createVoiceConversationRuntimeMachine().getSnapshot()).toMatchObject({ state: 'disconnected', reconnecting: false });
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(browser.peers).toHaveLength(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
    } finally {
      publishSelection(environment.entry.providerId);
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('forwards WebRTC media events and reconnects only after a terminal ICE failure', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.remoteDescriptionSet), starting]);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      browser.peer.channel.open();
      await starting;
      const firstPeer = browser.peer;
      const firstChannel = firstPeer.channel;
      const ownedAttempt = composed.controller?.getOwnedAttemptId();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      firstPeer.iceConnectionState = 'disconnected';
      firstPeer.dispatchEvent(new Event('iceconnectionstatechange'));
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      expect(firstChannel.readyState).toBe('open');
      expect(firstPeer.close).not.toHaveBeenCalled();
      expect(browser.peers).toHaveLength(1);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(useVoiceConversationRuntimeStore.getState().snapshot.reconnecting).toBe(false);
      expect(composed.controller?.getOwnedAttemptId()).toBe(ownedAttempt);

      firstPeer.iceConnectionState = 'failed';
      firstPeer.dispatchEvent(new Event('iceconnectionstatechange'));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot().reconnectRetryAvailable, value => value === true);
      expect(composed.runtime.adapter.getSnapshot().reconnectRetryAvailable).toBe(true);
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
      expect(firstChannel.readyState).toBe('closed');
      expect(browser.peers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect.baseBackoffMs);
      await browser.peerCreated(1).then(peer => peer.remoteDescriptionSet);
      expect(browser.peers).toHaveLength(2);
      expect(browser.peer.setRemoteDescription).toHaveBeenCalled();
      expect(browser.peer).not.toBe(firstPeer);
      expect(browser.peer.channel).not.toBe(firstChannel);
      browser.peer.channel.open();
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.runtime.adapter.getSnapshot(), snapshot => snapshot.status === 'connected' && !useVoiceConversationRuntimeStore.getState().snapshot.reconnecting);
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(useVoiceConversationRuntimeStore.getState().snapshot.reconnecting).toBe(false);
      expect(browser.peer.channel.readyState).toBe('open');
      expect(composed.controller?.getOwnedAttemptId()).toBe(ownedAttempt);
      expect(composed.controller?.getOwnedControlSessionId()).toBe(composed.controlSessionId);
      expect(environment.providerFetch.mock.calls.filter(([url]) => String(url).endsWith('/client_secrets'))).toHaveLength(1);
      expect(browser.micSession.teardown).not.toHaveBeenCalled();
      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      expect(firstPeer.close).toHaveBeenCalledTimes(1);
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
    } finally {
      vi.useRealTimers();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('coordinates canonical transcript projection and the all-results tool barrier', async () => {
    const connection = createConnectionFixture();
    const transcriptEvent = {
      v: 1 as const,
      type: 'voice.transcript.final' as const,
      epoch: 1,
      sequence: 1,
      revision: 1,
      eventId: 'event-controller-1',
      itemId: 'item-controller-1',
      role: 'user' as const,
      text: 'controller owns projection',
      provenance: 'live' as const,
    };
    const calls = [{
      v: 1 as const,
      responseId: 'response-controller-1',
      callId: 'call-controller-1',
      toolName: 'sendSessionMessage',
      order: 0,
      arguments: { message: 'controller projection effect' },
    }];
    connection.events.push({ type: 'session.created', event_id: 'controller-session-created' }, {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: transcriptEvent.eventId, item_id: transcriptEvent.itemId, transcript: transcriptEvent.text,
    }, openAiToolResponse('response-controller-1', calls));
    const executeCall = vi.fn(async () => ({ effectReceipt: 'controller-effect' }));
    const submitResults = vi.fn(async () => {});
    const toolBarrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation', authorizeCall: async () => ({ status: 'allowed' }),
      executeCall, redactResult: value => value, submitResults, continueResponse: async () => {},
    });
    const projectTranscript = vi.fn<NonNullable<VoiceConversationControllerDeps['projectTranscript']>>(
      ({ event }) => projectCanonicalVoiceTranscriptEvent({
        conversationSessionId: 'controller-canonical-session',
        event,
      }),
    );
    const input = {
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      projectTranscript,
      createToolBarrier: () => toolBarrier,
    };
    const controller = createVoiceConversationController(input);

    await controller.start({ controlSessionId: 'controller-canonical-session' });
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledOnce());
    expect(executeCall).toHaveBeenCalledWith(calls[0], expect.any(AbortSignal));
    expect(submitResults).toHaveBeenCalledWith('response-controller-1', [expect.objectContaining({
      callId: 'call-controller-1', status: 'success', output: { effectReceipt: 'controller-effect' },
    })], expect.any(AbortSignal));
    expect(projectTranscript).toHaveBeenCalledWith({
      controlSessionId: 'controller-canonical-session',
      attemptId: 1,
      connectionId: 1,
      event: transcriptEvent,
    });
    expect(readCanonicalVoiceTranscriptSnapshot('controller-canonical-session')).toEqual([
      expect.objectContaining({ itemId: 'item-controller-1', text: 'controller owns projection' }),
    ]);
    await controller.stop();
    await expect(toolBarrier.run({ responseId: 'response-after-stop', calls })).rejects.toMatchObject({ code: 'disposed' });
  });

  it('detaches provider delivery but preserves the attempt tool barrier across reconnect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    const calls = [{
      v: 1 as const, responseId: 'response-before-reconnect', callId: 'call-before-reconnect',
      toolName: 'sendSessionMessage', order: 0, arguments: { message: 'retained execution' },
    }];
    first.events.push(openAiToolResponse('response-before-reconnect', calls));
    const execution = deferred<VoiceRealtimeJsonValue>();
    let executionSignal: AbortSignal | null = null;
    const executeCall = vi.fn(async (_call: VoiceRealtimeToolCallV1, signal: AbortSignal) => {
      executionSignal = signal;
      return await execution.promise;
    });
    const submitResults = vi.fn(async () => {});
    const continueResponse = vi.fn(async () => {});
    const barrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation', authorizeCall: async () => ({ status: 'allowed' }),
      executeCall, redactResult: value => value, submitResults, continueResponse,
    });
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => barrier,
      waitBeforeReconnect: async () => {},
    });

    await controller.start({ controlSessionId: 'tool-reconnect' });
    await vi.waitFor(() => expect(executeCall).toHaveBeenCalledOnce());
    first.finishEvents();
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledOnce());
    expect(executionSignal).not.toBeNull();
    expect(executeCall.mock.calls[0]![1].aborted).toBe(false);
    expect(submitResults).not.toHaveBeenCalled();
    execution.resolve({ receipt: 'retained-execution' });
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledOnce());
    expect(submitResults).toHaveBeenCalledWith('response-before-reconnect', [expect.objectContaining({
      callId: 'call-before-reconnect', output: { receipt: 'retained-execution' },
    })], expect.any(AbortSignal));
    expect(executeCall).toHaveBeenCalledOnce();
    expect(continueResponse).toHaveBeenCalledOnce();
    await controller.stop();
    expect(executeCall.mock.calls[0]![1].aborted).toBe(true);
    await expect(barrier.run({ responseId: 'after-stop', calls })).rejects.toMatchObject({ code: 'disposed' });
  });
  it('reconnects and redelivers the same retained tool result without repeating the effect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    const calls = [{
      v: 1 as const,
      responseId: 'response-delivery-retry',
      callId: 'call-delivery-retry',
      toolName: 'sendSessionMessage',
      order: 0,
      arguments: { message: 'continue once' },
    }];
    first.events.push(openAiToolResponse('response-delivery-retry', calls));
    const executeCall = vi.fn(async () => ({ ok: true }));
    const submitResults = vi.fn()
      .mockRejectedValueOnce(new Error('provider connection lost'))
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => {});
    const toolBarrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    let connectionIndex = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => toolBarrier,
      waitBeforeReconnect: async () => {},
    });

    await controller.start({ controlSessionId: 'tool-delivery-retry' });
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledTimes(2));

    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(continueResponse).toHaveBeenCalledTimes(1);
    expect(machine.transitions).not.toContain('failed');

    await controller.stop();
  });

  it('redelivers a detached provider response through the retained barrier without repeating its effect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    const calls = [{
      v: 1 as const,
      responseId: 'response-transport-detach',
      callId: 'call-transport-detach',
      toolName: 'sendSessionMessage',
      order: 0,
      arguments: { message: 'deliver once' },
    }];
    first.events.push(openAiToolResponse('response-transport-detach', calls));
    const deliveryStarted = vi.fn();
    const executeCall = vi.fn(async () => ({ ok: true, receipt: 'transport-detach' }));
    const submitResults = vi.fn()
      .mockImplementationOnce(async (
        _responseId: string,
        _results: readonly unknown[],
        signal: AbortSignal,
      ) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('transport detached')), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => {});
    const toolBarrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    let connectionIndex = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => toolBarrier,
      waitBeforeReconnect: async () => {},
    });

    await controller.start({ controlSessionId: 'tool-transport-detach' });
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledTimes(1));
    first.finishEvents();
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledTimes(2));

    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(continueResponse).toHaveBeenCalledTimes(1);
    expect(machine.failureCodes).toEqual([]);

    await controller.stop();
  });

  it('fails the turn when detached settled tool results cannot be correlated to a resumed provider response', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    const calls = [{
      v: 1 as const,
      responseId: 'response-no-resume',
      callId: 'call-no-resume',
      toolName: 'sendSessionMessage',
      order: 0,
      arguments: { message: 'do not rerun' },
    }];
    first.events.push(openAiToolResponse('response-no-resume', calls));
    const deliveryStarted = vi.fn();
    const executeCall = vi.fn(async () => ({ ok: true, receipt: 'no-resume' }));
    const submitResults = vi.fn(async (
      _responseId: string,
      _results: readonly unknown[],
      signal: AbortSignal,
    ) => {
      deliveryStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('transport detached')), { once: true });
      });
    });
    const continueResponse = vi.fn(async () => {});
    const toolBarrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    let connectionIndex = 0;
    let preparationCount = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        // A declaration may support resumption in general while the next
        // prepared carrier is a fresh session with no stable call identity.
        prepare: async () => ({
          kind: 'prepared' as const,
          session: {
            config: {},
            safeMetadata: null,
            toolResultReplay: ++preparationCount === 1 ? 'stable_ids' as const : 'none' as const,
          },
        }),
      }),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => toolBarrier,
      waitBeforeReconnect: async () => {},
    });

    await controller.start({ controlSessionId: 'tool-no-resume' });
    await vi.waitFor(() => expect(deliveryStarted).toHaveBeenCalledTimes(1));
    first.finishEvents();
    await vi.waitFor(() => expect(machine.failureCodes).toEqual([
      'voice_tool_result_delivery_unrecoverable',
    ]));

    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(continueResponse).not.toHaveBeenCalled();

    await controller.stop();
  });

  it('retires an actual OpenAI attempt when a machine subscriber stops during connected publication', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    let stopping: Promise<void> | null = null;
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(next => {
      if (stopping || next.snapshot.controlSessionId !== composed.controlSessionId || next.snapshot.state !== 'connected') return;
      stopping = composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
    });
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      if (!stopping) throw new Error('Actual connected publication never reached the stop subscriber');
      await stopping;
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(composed.controller?.getActiveControlSessionId()).toBeNull();
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connected');
      expect(composed.runtime.adapter.getSnapshot().status).not.toBe('connecting');
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('fails closed when provider selection changes while session identity is being bound', async () => {
    const { withGeneratedElevenLabsVoiceRuntime } = await import('@/dev/testkit/harness/elevenLabsVoiceRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const identityRead = deferred<void>();
    const secondContextSent = deferred<void>();
    const first = { ...createElevenLabsSdkSession('elevenlabs-identity-A'), endSession: vi.fn(async () => {}), sendContextualUpdate: vi.fn() };
    const second = { ...createElevenLabsSdkSession('elevenlabs-identity-B'), endSession: vi.fn(async () => {}), sendContextualUpdate: vi.fn(() => secondContextSent.resolve()) };
    const readFirstIdentity = first.getId;
    vi.spyOn(first, 'getId').mockImplementation(() => {
      identityRead.resolve();
      return readFirstIdentity();
    });
    vi.spyOn(second, 'getId');
    elevenLabsSdk.startSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await withGeneratedElevenLabsVoiceRuntime(async ({ adapter, providerId }) => {
      const voice = storage.getState().settings.voiceSettingsV1;
      const publishSelection = (selection: string) => {
        const current = storage.getState().settings;
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
          voiceSettingsV1: { ...voice, providerId: selection },
        }, current));
      };
      const states: string[] = [];
      const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }, previous) => {
        if (snapshot.adapterId === providerId && snapshot.state !== previous.snapshot.state) states.push(snapshot.state);
      });
      try {
        const starting = adapter.start({ sessionId: '', requestedTargetSessionAddress: null,
          textOnly: true, initialContext: 'workspace context' });
        // The real handle has read the native SDK identity. A separate UI
        // action changes selection before its connection continuation resumes.
        await identityRead.promise;
        publishSelection('off');
        await expect(starting).resolves.toBeUndefined();
        expect(states).toEqual(['connecting', 'disconnected']);
        expect(first.endSession).toHaveBeenCalledTimes(1);
        expect(adapter.getSnapshot().status).not.toBe('connected');
        expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toBeNull();
        const outcomes = log.getLogs().filter(line => line.includes('[voiceRuntimeFailure]'))
          .map(line => JSON.parse(line.slice(line.indexOf('{'))));
        expect(outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'aborted' })]));
        // These are the vendor's actual callback arguments, not controller or
        // lifecycle hooks. Keep A's completion callback while B starts fresh.
        const oldOptions = elevenLabsSdk.startSession.mock.calls[0]![0] as ElevenLabsSdkStartOptions;
        if (!oldOptions.onDisconnect) throw new Error('Native ElevenLabs disconnect callback is absent');
        publishSelection(providerId);
        await adapter.start({ sessionId: '', requestedTargetSessionAddress: null, textOnly: true,
          initialContext: 'fresh workspace context' });
        expect(elevenLabsSdk.startSession).toHaveBeenCalledTimes(2);
        expect(elevenLabsSdk.startSession.mock.calls[1]?.[0]).not.toBe(oldOptions);
        expect(elevenLabsSdk.startSession.mock.calls[1]?.[0]).toMatchObject({
          dynamicVariables: { initialConversationContext: 'fresh workspace context' },
        });
        expect(second.getId).toHaveBeenCalled();
        expect(adapter.getSnapshot().status).toBe('connected');
        expect(first.endSession).toHaveBeenCalledTimes(1);
        expect(second.endSession).not.toHaveBeenCalled();
        const currentBinding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(currentBinding).not.toBeNull();
        oldOptions.onDisconnect({ reason: 'user' });
        adapter.sendContextUpdate({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, update: 'context for B only' });
        await secondContextSent.promise;
        expect(second.sendContextualUpdate).toHaveBeenCalledWith('context for B only');
        expect(first.sendContextualUpdate).not.toHaveBeenCalled();
        expect(adapter.getSnapshot().status).toBe('connected');
        expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)).toEqual(currentBinding);
        expect(second.endSession).not.toHaveBeenCalled();
        await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
        expect(second.endSession).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
        publishSelection(providerId);
      }
    });
  });

  it('ends the conversation when the selection goes stale under a live control stream', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      await environment.configureVoice({ ...environment.persistedAccountSettings.voiceSettingsV1, providerId: 'off' });
      expect(browser.peer.channel.readyState).toBe('open');
      browser.peer.channel.message(JSON.stringify({ type: 'input_audio_buffer.speech_started', event_id: 'stale-control' }));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.controller?.getOwnedControlSessionId(), id => id === null);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(useVoiceConversationRuntimeStore.getState().snapshot).toMatchObject({
        state: 'disconnected', reconnecting: false, error: { reason: 'voice_provider_not_selected' },
      });
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error', canStop: false, errorCode: 'voice_provider_not_selected',
      });
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });

  it('ends the conversation when the selection goes stale under a live transport stream', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    try {
      const starting = composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
      await Promise.race([browser.peerCreated().then(peer => peer.dataChannelCreated), starting]);
      expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events');
      browser.peer.channel.open();
      await starting;
      await environment.configureVoice({ ...environment.persistedAccountSettings.voiceSettingsV1, providerId: 'off' });
      expect(browser.peer.channel.readyState).toBe('open');
      browser.peer.iceConnectionState = 'connected';
      browser.peer.dispatchEvent(new Event('iceconnectionstatechange'));
      await waitForTestEvent(composed.runtime.adapter.subscribe!, () => composed.controller?.getOwnedControlSessionId(), id => id === null);
      expect(composed.controller?.getOwnedControlSessionId()).toBeNull();
      expect(useVoiceConversationRuntimeStore.getState().snapshot).toMatchObject({
        state: 'disconnected', reconnecting: false, error: { reason: 'voice_provider_not_selected' },
      });
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({
        status: 'error', canStop: false, errorCode: 'voice_provider_not_selected',
      });
      expect(browser.peer.close).toHaveBeenCalledTimes(1);
      expect(browser.micTrack.stop).toHaveBeenCalledTimes(1);
      expect(browser.micSession.teardown).toHaveBeenCalledTimes(1);
    } finally {
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      await environment.dispose();
      browser.restore();
    }
  });
});
