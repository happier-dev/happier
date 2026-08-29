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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  it('keeps projected and provider mute state current without mutating the host mic', async () => {
    const providerId = 'realtime_mute_owner';
    const controlSessionId = 'voice-session';
    const runtimeMachine = createVoiceConversationRuntimeMachine();
    runtimeMachine.reset();
    const settledInitialMute = createDeferredVoid();
    const delayedUnmuteA = createDeferredVoid();
    const delayedMuteB = createDeferredVoid();
    const rejectedUnmute = createDeferredVoid();
    const delayedReplacedUnmute = createDeferredVoid();
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
      await operation.deferred.promise;
      providerCapture.muted = muted;
      providerSettlements.push(muted);
    });
    const physicalTrack = { enabled: true };
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
    const capturedControllerDeps: {
      current: Parameters<typeof createVoiceConversationController>[0] | null;
    } = { current: null };
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
      createConversationController: (deps) => {
        capturedControllerDeps.current = deps;
        return createVoiceConversationController(deps);
      },
      createMicSession: vi.fn(() => mic),
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
      detach: vi.fn(),
      cancel: vi.fn(),
        dispose: vi.fn(),
      })),
      voiceHooks: { onStarted: vi.fn(() => ''), onStopped: vi.fn() },
      createMachineError: createVoiceMachineError,
    } satisfies BundledRealtimeProviderRuntimeHost;
    const createRuntime = (
      runtimeProviderId: string,
      runtimeSetInputMuted: (muted: boolean) => Promise<void>,
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
      microphoneMode: 'provider_managed',
      setInputMuted: runtimeSetInputMuted,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    const runtime = createRuntime(providerId, setInputMuted);

    try {
      await runtime.adapter.start({ sessionId: controlSessionId });
      expect(setInputMuted).toHaveBeenCalledWith(false);
      const initialMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      expect(physicalTrack.enabled).toBe(true);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(false);

      settledInitialMute.resolve();
      await initialMute;
      expect(providerCapture.muted).toBe(true);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);

      const unmuteA = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      expect(physicalTrack.enabled).toBe(true);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      const muteB = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      expect(physicalTrack.enabled).toBe(true);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);

      delayedMuteB.resolve();
      delayedUnmuteA.resolve();
      await Promise.all([unmuteA, muteB]);

      expect(providerCapture.muted).toBe(true);
      expect(providerSettlements).toEqual([false, false, true, false, true]);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      expect(physicalTrack.enabled).toBe(true);

      const failedUnmute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      rejectedUnmute.reject(new Error('provider_input_mute_rejected'));
      await expect(failedUnmute).rejects.toThrow('provider_input_mute_rejected');
      const callsAfterRejectedUnmute = setInputMuted.mock.calls.length;
      await runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });

      expect(providerCapture.muted).toBe(true);
      expect(setInputMuted).toHaveBeenCalledTimes(callsAfterRejectedUnmute);
      expect(runtimeMachine.getSnapshot().micMuted).toBe(true);
      expect(physicalTrack.enabled).toBe(true);

      await capturedControllerDeps.current?.onConnectionReady?.({
        controlSessionId,
        attemptId: 1,
        request: {},
        connection: createOpenConnection(),
        signal: new AbortController().signal,
      });
      expect(setInputMuted).toHaveBeenLastCalledWith(true);

      const replacedUnmute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      await vi.waitFor(() => expect(setInputMuted).toHaveBeenCalledTimes(8));
      // Replacement is a lifecycle boundary, not a second concurrent Start on
      // the same adapter. Stop must retire the old attempt without joining a
      // public provider hook that may remain pending indefinitely.
      await runtime.adapter.stop({ sessionId: controlSessionId });
      const replacementStart = runtime.adapter.start({ sessionId: controlSessionId });
      await expect(replacementStart).rejects.toThrow('voice_input_mute_failed');

      // The replacement attempt must fail closed before entering the same
      // provider-owned capture side effect while retired attempt A can still
      // settle afterward and physically unmute it. The public hook has no
      // cancellation signal, so Start must remain bounded without overlapping.
      expect(setInputMuted).toHaveBeenCalledTimes(8);
      expect(providerCapture.muted).toBe(true);

      delayedReplacedUnmute.resolve();
      await replacedUnmute;
      await runtime.adapter.start({ sessionId: controlSessionId });

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
      expect(physicalTrack.enabled).toBe(true);

      await runtime.adapter.setMuted({ sessionId: controlSessionId, muted: false });
      const failedMute = runtime.adapter.setMuted({ sessionId: controlSessionId, muted: true });
      expect(physicalTrack.enabled).toBe(true);
      rejectedTerminalMute.reject(new Error('provider_input_mute_rejected'));
      await expect(failedMute).rejects.toThrow('provider_input_mute_rejected');
      await vi.waitFor(() => expect(['disconnected', 'error']).toContain(
        runtimeMachine.getSnapshot().state,
      ));
      expect(mic.setMuted).not.toHaveBeenCalled();
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
