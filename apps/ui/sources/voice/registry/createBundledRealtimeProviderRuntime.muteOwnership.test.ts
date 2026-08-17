import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeConnection } from '@happier-dev/plugin-sdk/voice/client';

import type { BundledRealtimeProviderRuntimeHost } from '@/voice/registry/bundledConversationRuntimeContract';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';

function createDeferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createOpenConnection(): VoiceRealtimeConnection {
  let open = false;
  return {
    kind: 'sdk_handle',
    connect: async () => {
      open = true;
    },
    close: async () => {
      open = false;
    },
    sendControl: async () => undefined,
    controlEvents: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    transportEvents: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    state: () => open ? 'open' : 'closed',
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate: () => {},
  };
}

describe('createBundledRealtimeProviderRuntime mute ownership', () => {
  it('keeps the replacement attempt physically unmuted and projected unmuted when an old provider mute settles late', async () => {
    const providerId = 'realtime_mute_owner';
    const controlSessionId = 'voice-session';
    const runtimeMachine = createVoiceConversationRuntimeMachine();
    runtimeMachine.reset();
    const delayedFirstProviderMute = createDeferredVoid();
    const delayedSecondProviderMute = createDeferredVoid();
    let providerMuteCalls = 0;
    const setInputMuted = vi.fn(async () => {
      providerMuteCalls += 1;
      if (providerMuteCalls === 1) await delayedFirstProviderMute.promise;
      if (providerMuteCalls === 2) await delayedSecondProviderMute.promise;
    });
    const physicalTrack = { enabled: true };
    const replacementProviderTrack = { enabled: true };
    const createMic = (track: { enabled: boolean }) => {
      let micMuted = false;
      return {
        ensureActive: vi.fn(async () => undefined),
        teardown: vi.fn(async () => undefined),
        setMuted: vi.fn((muted: boolean) => {
          micMuted = muted;
          track.enabled = !muted;
        }),
        isMuted: vi.fn(() => micMuted),
        getStream: vi.fn(() => ({ getAudioTracks: () => [] } as unknown as MediaStream)),
        getAudioContext: vi.fn(() => null),
      };
    };
    const mic = createMic(physicalTrack);
    const replacementProviderMic = createMic(replacementProviderTrack);
    const micSessions = [mic, replacementProviderMic];
    let selectedProviderId = providerId;
    let transcriptEpoch = 0;
    const host = {
      globalVoiceSessionId: controlSessionId,
      runCurrentGenerationEffect(callback: () => void): boolean {
        callback();
        return true;
      },
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId: selectedProviderId } }),
      projectVoiceSettings: () => ({ providerId: selectedProviderId, providerConfig: {} }),
      machine: {
        transitionToAcquiringMic: (sessionId: string, adapterId: string, attemptId?: number) =>
          runtimeMachine.transitionToAcquiringMic({ controlSessionId: sessionId, adapterId, attemptId }),
        transitionToConnecting: (sessionId: string, adapterId: string, attemptId?: number) =>
          runtimeMachine.transitionToConnecting({ controlSessionId: sessionId, adapterId, attemptId }),
        setReconnecting: (sessionId: string, adapterId: string, reconnecting: boolean, attemptId?: number) =>
          runtimeMachine.setReconnecting({
            controlSessionId: sessionId,
            adapterId,
            attemptId,
            reconnecting,
          }),
        transitionToConnected: (sessionId: string, adapterId: string, attemptId?: number) =>
          runtimeMachine.transitionToConnected({ controlSessionId: sessionId, adapterId, attemptId }),
        transitionToSpeaking: (sessionId: string, adapterId: string, attemptId?: number) =>
          runtimeMachine.transitionToSpeaking({ controlSessionId: sessionId, adapterId, attemptId }),
        transitionToEnding: (sessionId: string, adapterId: string, attemptId?: number) =>
          runtimeMachine.transitionToEnding({ controlSessionId: sessionId, adapterId, attemptId }),
        transitionToDisconnected: (
          sessionId: string,
          adapterId: string,
          error: unknown | null,
          attemptId?: number,
        ) => runtimeMachine.transitionToDisconnected({
          controlSessionId: sessionId,
          adapterId,
          attemptId,
          error: error as Parameters<typeof runtimeMachine.transitionToDisconnected>[0]['error'],
        }),
        setError: (sessionId: string, adapterId: string, error: unknown, attemptId?: number) =>
          runtimeMachine.setError({
            controlSessionId: sessionId,
            adapterId,
            attemptId,
            error: error as Parameters<typeof runtimeMachine.setError>[0]['error'],
          }),
        setMuted: (sessionId: string, adapterId: string, attemptId: number, muted: boolean) =>
          runtimeMachine.setMuted({
            controlSessionId: sessionId,
            adapterId,
            attemptId,
            micMuted: muted,
          }),
        getSnapshot: runtimeMachine.getSnapshot,
        projectSnapshot: (adapterId: string, snapshot: unknown) => deriveLocalVoiceSessionSnapshot(
          adapterId,
          'realtime',
          snapshot as Parameters<typeof deriveLocalVoiceSessionSnapshot>[2],
        ),
        subscribe: (listener: () => void) => useVoiceConversationRuntimeStore.subscribe(listener),
      },
      createConversationController: createVoiceConversationController,
      createMicSession: vi.fn(() => micSessions.shift() ?? mic),
      createSdkHandleConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebRtcConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmMedia: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmConnection: vi.fn(() => { throw new Error('unused'); }),
      ensureBound: vi.fn(async () => undefined),
      acquireDirectMediaConversation: vi.fn(async () => ({ conversationSessionId: controlSessionId })),
      releaseDirectMediaConversation: vi.fn(async () => undefined),
      resolveConversationSessionId: vi.fn(() => controlSessionId),
      applyTargetSelection: vi.fn(async () => undefined),
      acquireAudioMode: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
      openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
      projectTranscript: vi.fn(() => null),
      admitTranscriptPersistenceEvent: vi.fn(() => null),
      commitAdmittedTranscriptPersistenceEvent: vi.fn(() => null),
      releaseAdmittedTranscriptPersistenceEvent: vi.fn(() => false),
      settleTranscriptPersistence: vi.fn(async () => undefined),
      beginTranscriptAttempt: vi.fn(() => {
        transcriptEpoch += 1;
        return { epoch: transcriptEpoch, attemptIdentity: `attempt-${transcriptEpoch}` };
      }),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({
        run: vi.fn(async () => ({ status: 'submitted' as const })),
        cancel: vi.fn(),
        dispose: vi.fn(),
      })),
      voiceHooks: { onStarted: vi.fn(() => ''), onStopped: vi.fn() },
      createMachineError: createVoiceMachineError,
    } satisfies BundledRealtimeProviderRuntimeHost;
    const createRuntime = (
      runtimeProviderId: string,
      runtimeSetInputMuted?: (muted: boolean) => Promise<void>,
    ) => createBundledRealtimeProviderRuntime(host, {
      providerId: runtimeProviderId,
      execution: { kind: 'direct_media' },
      protocol: {
        id: runtimeProviderId,
        turnControls: {
          cancelResponse: 'unsupported',
          truncatePlayback: 'unsupported',
          clearInput: false,
          stopSession: false,
          resumption: 'none',
          replay: 'none',
          exactMessage: true,
        },
        prepare: vi.fn(async () => ({
          kind: 'prepared' as const,
          session: { config: null, safeMetadata: null },
        })),
        decodeControl: vi.fn(() => []),
        encodeTurnControl: vi.fn(() => null),
      },
      createConnection: vi.fn(async () => createOpenConnection()),
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
      microphoneMode: 'host_webrtc',
      ...(runtimeSetInputMuted ? { setInputMuted: runtimeSetInputMuted } : {}),
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    const runtime = createRuntime(providerId, setInputMuted);
    let replacementRuntime: ReturnType<typeof createBundledRealtimeProviderRuntime> | null = null;

    try {
      await runtime.adapter.start({ sessionId: controlSessionId });
      const staleMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      expect(physicalTrack.enabled).toBe(false);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);

      await runtime.adapter.start({ sessionId: controlSessionId });

      expect(runtimeMachine.getSnapshot()).toMatchObject({
        controlSessionId,
        adapterId: providerId,
        state: 'connected',
        micMuted: false,
      });
      expect(physicalTrack.enabled).toBe(true);

      delayedFirstProviderMute.resolve();
      await staleMute;

      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);
      expect(physicalTrack.enabled).toBe(true);

      const staleSameProviderMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });

      expect(physicalTrack.enabled).toBe(false);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);

      const replacementProviderId = 'realtime_mute_replacement';
      selectedProviderId = replacementProviderId;
      replacementRuntime = createRuntime(replacementProviderId, async () => undefined);
      await replacementRuntime.adapter.start({ sessionId: controlSessionId });

      expect(runtimeMachine.getSnapshot()).toMatchObject({
        controlSessionId,
        adapterId: replacementProviderId,
        state: 'connected',
        micMuted: false,
      });
      expect(replacementProviderTrack.enabled).toBe(true);

      delayedSecondProviderMute.resolve();
      await staleSameProviderMute;

      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);
      expect(replacementProviderTrack.enabled).toBe(true);

      await replacementRuntime.adapter.setMuted({ sessionId: controlSessionId, muted: true });

      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      expect(replacementProviderTrack.enabled).toBe(false);
      expect(physicalTrack.enabled).toBe(false);
    } finally {
      delayedFirstProviderMute.resolve();
      delayedSecondProviderMute.resolve();
      await replacementRuntime?.dispose();
      await runtime.dispose();
      runtimeMachine.reset();
    }
  });
});
