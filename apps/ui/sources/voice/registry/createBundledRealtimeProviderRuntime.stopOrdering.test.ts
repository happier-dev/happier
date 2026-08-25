import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeConnection } from '@happier-dev/plugin-sdk/voice/client';

import type {
  BundledRealtimeProviderRuntimeHost,
  BundledVoiceMicSession,
} from '@/voice/registry/bundledConversationRuntimeContract';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';

/**
 * A microphone whose acquisition only settles when `teardown()` invalidates it —
 * the exact contract the web mic owner implements so an unanswered permission
 * prompt cannot pin its callers forever.
 */
function createInvalidationOnlyMic() {
  let invalidate: (() => void) | null = null;
  return {
    teardown: vi.fn(async () => {
      invalidate?.();
      invalidate = null;
    }),
    ensureActive: vi.fn(async () => {
      await new Promise<void>((resolve) => {
        invalidate = resolve;
      });
    }),
    setMuted: vi.fn(() => undefined),
    isMuted: vi.fn(() => false),
    getStream: vi.fn(() => null),
    getAudioContext: vi.fn(() => null),
  };
}

function createOpenConnection(): VoiceRealtimeConnection {
  let open = false;
  return {
    kind: 'sdk_handle',
    connect: async () => { open = true; },
    close: async () => { open = false; },
    sendControl: async () => undefined,
    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    state: () => open ? 'open' : 'closed',
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    beginOutputInterruptionCandidate: () => 'unsupported',
    resolveOutputInterruptionCandidate: () => {},
  };
}

const CONTROL_SESSION_ID = 'voice-session';

function createHarness(input: Readonly<{
  providerId: string;
  mic: BundledVoiceMicSession;
}>) {
  const { providerId, mic } = input;
  const runtimeMachine = createVoiceConversationRuntimeMachine();
  runtimeMachine.reset();
  let transcriptEpoch = 0;
  const host = {
    globalVoiceSessionId: CONTROL_SESSION_ID,
    runCurrentGenerationEffect(callback: () => void): boolean {
      callback();
      return true;
    },
    getPlatform: () => 'web' as const,
    getRealtimeClientToolDefinitions: () => [],
    getSettings: () => ({ voice: { providerId } }),
    projectVoiceSettings: () => ({ providerId, providerConfig: {} }),
    machine: {
      transitionToAcquiringMic: (sessionId: string, adapterId: string, attemptId?: number) =>
        runtimeMachine.transitionToAcquiringMic({ controlSessionId: sessionId, adapterId, attemptId }),
      transitionToConnecting: (sessionId: string, adapterId: string, attemptId?: number) =>
        runtimeMachine.transitionToConnecting({ controlSessionId: sessionId, adapterId, attemptId }),
      setReconnecting: (sessionId: string, adapterId: string, reconnecting: boolean, attemptId?: number) =>
        runtimeMachine.setReconnecting({ controlSessionId: sessionId, adapterId, attemptId, reconnecting }),
      transitionToConnected: (sessionId: string, adapterId: string, attemptId?: number) =>
        runtimeMachine.transitionToConnected({ controlSessionId: sessionId, adapterId, attemptId }),
      transitionToSpeaking: (sessionId: string, adapterId: string, attemptId?: number) =>
        runtimeMachine.transitionToSpeaking({ controlSessionId: sessionId, adapterId, attemptId }),
      transitionToEnding: (sessionId: string, adapterId: string, attemptId?: number) =>
        runtimeMachine.transitionToEnding({ controlSessionId: sessionId, adapterId, attemptId }),
      transitionToDisconnected: (sessionId: string, adapterId: string, error: unknown | null, attemptId?: number) =>
        runtimeMachine.transitionToDisconnected({
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
        runtimeMachine.setMuted({ controlSessionId: sessionId, adapterId, attemptId, micMuted: muted }),
      getSnapshot: runtimeMachine.getSnapshot,
      projectSnapshot: (adapterId: string, snapshot: unknown) => deriveLocalVoiceSessionSnapshot(
        adapterId,
        'realtime',
        snapshot as Parameters<typeof deriveLocalVoiceSessionSnapshot>[2],
      ),
      subscribe: (listener: () => void) => useVoiceConversationRuntimeStore.subscribe(listener),
    },
    createConversationController: createVoiceConversationController,
    createMicSession: vi.fn(() => mic),
    createSdkHandleConnection: vi.fn(() => { throw new Error('unused'); }),
    createWebRtcConnection: vi.fn(() => { throw new Error('unused'); }),
    createWebSocketPcmMedia: vi.fn(() => { throw new Error('unused'); }),
    createWebSocketPcmConnection: vi.fn(() => { throw new Error('unused'); }),
    ensureBound: vi.fn(async () => undefined),
    acquireDirectMediaConversation: vi.fn(async () => ({ conversationSessionId: CONTROL_SESSION_ID })),
    releaseDirectMediaConversation: vi.fn(async () => undefined),
    resolveConversationSessionId: vi.fn(() => CONTROL_SESSION_ID),
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
  const runtime = createBundledRealtimeProviderRuntime(host, {
    providerId,
    execution: { kind: 'direct_media' },
    protocol: {
      id: providerId,
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
    encodeContextUpdate: vi.fn(() => []),
    encodeTextTurn: vi.fn(() => []),
    resolveSurfaceCapabilities: vi.fn(() => null),
  });
  return { host, runtime };
}

/** Resolves once `promise` settles, or after `ms` — never hangs the test runner. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  ]);
  return settled;
}

describe('createBundledRealtimeProviderRuntime stop ordering', () => {
  it('tears the attempt microphone down before joining preparation so Stop cannot deadlock behind an unsettled acquisition', async () => {
    const mic = createInvalidationOnlyMic();
    const { runtime } = createHarness({ providerId: 'realtime_stop_deadlock', mic });

    const start = runtime.adapter.start({ sessionId: CONTROL_SESSION_ID });
    void start.catch(() => undefined);
    await vi.waitFor(() => expect(mic.ensureActive).toHaveBeenCalledTimes(1));
    expect(mic.teardown).not.toHaveBeenCalled();

    const stop = runtime.adapter.stop({ sessionId: CONTROL_SESSION_ID });
    expect(await settledWithin(stop, 250)).toBe(true);
    expect(mic.teardown).toHaveBeenCalledTimes(1);

    await stop;
    await start.catch(() => undefined);
    await runtime.dispose();
  });
});
