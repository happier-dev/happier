import { describe, expect, it, vi } from 'vitest';

import type { VoiceConversationController, VoiceConversationControllerDeps } from '@/voice/runtime/controller/VoiceConversationController';
import type { BundledRealtimeProviderRuntimeHost } from '@/voice/registry/bundledConversationRuntimeContract';

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';

type MicrophoneMode = 'host_webrtc' | 'host_pcm' | 'provider_managed';

function createRuntimeForMode(mode: MicrophoneMode) {
  let resources: VoiceConversationControllerDeps['resources'] | undefined;
  const mic = {
    ensurePermission: vi.fn(async () => undefined),
    ensureActive: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
    setMuted: vi.fn(),
    isMuted: vi.fn(() => false),
    getStream: vi.fn(() => ({}) as MediaStream),
  };
  const acquireAudioMode = vi.fn(async () => ({ release: vi.fn(async () => undefined) }));
  const setInputMuted = vi.fn(async () => undefined);
  const controller: VoiceConversationController = {
    async start(input) {
      await resources?.prepare?.({
        controlSessionId: input.controlSessionId,
        attemptId: 1,
        request: {},
        signal: new AbortController().signal,
      });
      return { status: 'connected' };
    },
    stop: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    performTurnControl: vi.fn(async () => ({ status: 'unavailable' as const, code: 'voice_turn_action_unsupported' as const })),
    sendClientControl: vi.fn(async () => ({ status: 'sent' as const })),
    getActiveControlSessionId: vi.fn(() => null),
    getOwnedControlSessionId: vi.fn(() => 'voice-test'),
    getOwnedAttemptId: vi.fn(() => 1),
    requestReconnect: vi.fn(async () => false),
    playbackCursorMs: vi.fn(() => null),
    beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
    resolveOutputInterruptionCandidate: vi.fn(),
  };
  const host = {
    globalVoiceSessionId: 'voice-global',
    runCurrentGenerationEffect(callback: () => void) {
      callback();
      return true;
    },
    getPlatform: () => 'ios' as const,
    getRealtimeClientToolDefinitions: () => [],
    getSettings: () => ({ voice: { providerId: 'test-provider' } }),
    projectVoiceSettings: () => ({ providerId: 'test-provider', providerConfig: {} }),
    machine: {
      transitionToAcquiringMic: vi.fn(),
      transitionToConnecting: vi.fn(),
      setReconnecting: vi.fn(),
      transitionToConnected: vi.fn(),
      transitionToSpeaking: vi.fn(),
      transitionToEnding: vi.fn(),
      transitionToDisconnected: vi.fn(),
      setError: vi.fn(),
      setMuted: vi.fn(),
      getSnapshot: vi.fn(() => ({ status: 'disconnected' })),
      projectSnapshot: vi.fn(() => ({
        adapterId: 'test-provider',
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
      })),
      subscribe: vi.fn(() => vi.fn()),
    },
    createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
      resources = input.resources;
      return controller;
    }),
    createMicSession: vi.fn(() => mic),
    createSdkHandleConnection: vi.fn(() => { throw new Error('unused'); }),
    createWebRtcConnection: vi.fn(() => { throw new Error('unused'); }),
    createWebSocketPcmMedia: vi.fn(() => { throw new Error('unused'); }),
    createWebSocketPcmConnection: vi.fn(() => { throw new Error('unused'); }),
    ensureBound: vi.fn(async () => undefined),
    acquireDirectMediaConversation: vi.fn(async ({ controlSessionId }) => ({
      conversationSessionId: controlSessionId,
    })),
    releaseDirectMediaConversation: vi.fn(async () => undefined),
    resolveConversationSessionId: vi.fn((controlSessionId: string) => controlSessionId),
    applyTargetSelection: vi.fn(async () => undefined),
    acquireAudioMode,
    openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
    projectTranscript: vi.fn(() => null),
    admitTranscriptPersistenceEvent: vi.fn(() => null),
    commitAdmittedTranscriptPersistenceEvent: vi.fn(() => null),
    releaseAdmittedTranscriptPersistenceEvent: vi.fn(() => false),
    settleTranscriptPersistence: vi.fn(async () => undefined),
    beginTranscriptAttempt: vi.fn(() => ({ epoch: 1, attemptIdentity: 'attempt-1' })),
    presentHostedLeaseNotice: vi.fn(),
    presentAttemptDiagnostic: vi.fn(),
    clearAttemptStatus: vi.fn(),
    createToolBarrier: vi.fn(() => ({ run: vi.fn(async () => ({ status: 'submitted' })), detach: vi.fn(), cancel: vi.fn(), dispose: vi.fn() })),
    voiceHooks: { onStarted: vi.fn(() => ''), onStopped: vi.fn() },
    createMachineError: vi.fn((input) => ({
      ...input,
      phase: 'runtime' as const,
      retryPolicy: 'user_action' as const,
      recoveryAction: 'retry' as const,
      presentation: 'error' as const,
      recoverable: true,
    })),
  } as unknown as BundledRealtimeProviderRuntimeHost;
  const runtime = createBundledRealtimeProviderRuntime(host, {
    providerId: 'test-provider',
    execution: { kind: 'direct_media' },
    protocol: {
      id: 'test-provider',
      turnControls: {
        cancelResponse: 'unsupported',
        truncatePlayback: 'unsupported',
        clearInput: false,
        stopSession: false,
        resumption: 'none',
        replay: 'none',
        exactMessage: true,
      },
      prepare: vi.fn(async () => ({ kind: 'prepared' as const, session: { config: null, safeMetadata: null } })),
      decodeControl: vi.fn(() => []),
      encodeTurnControl: vi.fn(() => null),
    },
    microphoneMode: mode,
    ...(mode === 'provider_managed' ? { setInputMuted } : {}),
    createConnection: vi.fn(async () => { throw new Error('unused'); }),
    encodeToolResults: vi.fn(() => []),
    encodeToolContinuation: vi.fn(() => null),
    encodeContextUpdate: vi.fn(() => []),
    encodeTextTurn: vi.fn(() => []),
    resolveSurfaceCapabilities: vi.fn(() => null),
  } as never);

  return { runtime, mic, acquireAudioMode, setInputMuted };
}

describe('createBundledRealtimeProviderRuntime microphone mode', () => {
  it('chooses one declared microphone authority before connection creation', async () => {
    const webRtc = createRuntimeForMode('host_webrtc');
    await webRtc.runtime.adapter.start({ sessionId: 'voice-test' });
    expect(webRtc.mic.ensurePermission).toHaveBeenCalledTimes(1);
    expect(webRtc.mic.ensureActive).toHaveBeenCalledTimes(1);
    expect(webRtc.acquireAudioMode).toHaveBeenCalledTimes(1);

    const pcm = createRuntimeForMode('host_pcm');
    await pcm.runtime.adapter.start({ sessionId: 'voice-test' });
    expect(pcm.mic.ensurePermission).toHaveBeenCalledTimes(1);
    expect(pcm.mic.ensureActive).not.toHaveBeenCalled();
    expect(pcm.acquireAudioMode).not.toHaveBeenCalled();

    const providerManaged = createRuntimeForMode('provider_managed');
    await providerManaged.runtime.adapter.start({ sessionId: 'voice-test' });
    expect(providerManaged.mic.ensurePermission).not.toHaveBeenCalled();
    expect(providerManaged.mic.ensureActive).not.toHaveBeenCalled();
    expect(providerManaged.acquireAudioMode).toHaveBeenCalledTimes(1);
    expect(providerManaged.mic.setMuted).not.toHaveBeenCalled();
    await providerManaged.runtime.adapter.setMuted({ sessionId: 'voice-test', muted: true });
    expect(providerManaged.setInputMuted).toHaveBeenCalledWith(true);
    expect(providerManaged.mic.setMuted).not.toHaveBeenCalled();
  });

  it('holds the audio-mode lease before host WebRTC capture opens its track', async () => {
    const webRtc = createRuntimeForMode('host_webrtc');
    await webRtc.runtime.adapter.start({ sessionId: 'voice-test' });

    // The platform decides the capture route and echo cancellation when the
    // track is created: Android reads `AudioManager.mode` and AEC availability
    // at `AudioRecord` construction. Acquiring the canonical lease afterwards
    // leaves the whole call on the media route with no AEC. Permission is
    // prompted first so an unanswered prompt never holds the exclusive session.
    const permissionOrder = webRtc.mic.ensurePermission.mock.invocationCallOrder[0];
    const leaseOrder = webRtc.acquireAudioMode.mock.invocationCallOrder[0];
    const captureOrder = webRtc.mic.ensureActive.mock.invocationCallOrder[0];
    expect(permissionOrder).toBeDefined();
    expect(leaseOrder).toBeDefined();
    expect(captureOrder).toBeDefined();
    expect(permissionOrder!).toBeLessThan(leaseOrder!);
    expect(leaseOrder!).toBeLessThan(captureOrder!);
  });
});
