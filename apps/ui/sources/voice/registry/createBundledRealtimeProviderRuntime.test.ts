import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';
import type {
  BundledRealtimeProviderRuntimeHost,
  VoiceConversationController,
  VoiceConversationControllerDeps,
  VoiceConversationControllerStartResult,
  VoiceRealtimeConnection,
  VoiceMachineErrorKind,
  VoiceTurnControlAction,
} from '@happier-dev/bundled-voice-runtime-contract';

import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';

const markAssistantInterrupted = vi.hoisted(() => vi.fn());
vi.mock('@/voice/transcript/voiceTurnInterruption', () => ({
  markVoiceConversationAssistantTurnInterrupted: markAssistantInterrupted,
}));

function createDeferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createBundledRealtimeProviderRuntime', () => {
  it('keeps same-session replacement B live while established A stop cleanup settles', async () => {
    const providerId = 'realtime_overlap';
    const controlSessionId = 'shared-control-session';
    const staleConnectionClose = createDeferredVoid();
    const runtimeMachine = createVoiceConversationRuntimeMachine();
    runtimeMachine.reset();
    let controllerInput: VoiceConversationControllerDeps | null = null;
    let micActive = false;
    let activeProviderPreparation: number | null = null;
    let preparationSequence = 0;
    let transcriptEpoch = 0;
    const mic = {
      ensureActive: vi.fn(async () => { micActive = true; }),
      teardown: vi.fn(async () => { micActive = false; }),
      setMuted: vi.fn(),
      isMuted: vi.fn(() => false),
      getStream: vi.fn(() => null),
      getAudioContext: vi.fn(() => null),
    };
    const releaseDirectMediaConversation = vi.fn();
    const releasePrepared = vi.fn(async (input: Readonly<{ attemptId: number }>) => {
      if (activeProviderPreparation === input.attemptId) {
        activeProviderPreparation = null;
      }
    });
    const connections = new Map<number, VoiceRealtimeConnection>();
    const sendControlByAttempt = new Map<number, ReturnType<typeof vi.fn>>();
    const createConnection = vi.fn(async (input: Readonly<{ attemptId: number }>) => {
      const attemptId = input.attemptId;
      let open = false;
      const sendControl = vi.fn(async () => {
        if (!open) throw new Error('voice_connection_not_open');
        if (!micActive) throw new Error('replacement_mic_released');
        if (activeProviderPreparation !== attemptId) {
          throw new Error('replacement_provider_preparation_released');
        }
      });
      sendControlByAttempt.set(attemptId, sendControl);
      const connection = {
        kind: 'sdk_handle' as const,
        async connect() {
          open = true;
        },
        sendControl,
        controlEvents: (signal: AbortSignal) => ({
          async *[Symbol.asyncIterator]() {
            if (signal.aborted) return;
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        }),
        transportEvents: (signal: AbortSignal) => ({
          async *[Symbol.asyncIterator]() {
            if (signal.aborted) return;
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          },
        }),
        async close() {
          if (attemptId === 1) await staleConnectionClose.promise;
          open = false;
        },
        state: () => open ? 'open' as const : 'closed' as const,
        currentProviderSessionId: () => `provider-session-${attemptId}`,
        playbackCursorMs: () => null,
        beginOutputInterruptionCandidate: () => 'unsupported' as const,
        resolveOutputInterruptionCandidate: vi.fn(),
      } satisfies VoiceRealtimeConnection;
      connections.set(attemptId, connection);
      activeProviderPreparation = attemptId;
      return connection;
    });
    const projectTranscript = vi.fn(() => null);
    const onStopped = vi.fn();
    const firstCarrierAcquisition = createDeferredVoid();
    let carrierAcquisitionCount = 0;
    const host = {
      globalVoiceSessionId: controlSessionId,
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId } }),
      projectVoiceSettings: () => ({ providerId, providerConfig: {} }),
      machine: {
        transitionToAcquiringMic: (sessionId: string, adapterId: string) =>
          runtimeMachine.transitionToAcquiringMic({ controlSessionId: sessionId, adapterId }),
        transitionToConnecting: (sessionId: string, adapterId: string) =>
          runtimeMachine.transitionToConnecting({ controlSessionId: sessionId, adapterId }),
        setReconnecting: (sessionId: string, adapterId: string, reconnecting: boolean) =>
          runtimeMachine.setReconnecting({ controlSessionId: sessionId, adapterId, reconnecting }),
        transitionToConnected: (sessionId: string, adapterId: string) =>
          runtimeMachine.transitionToConnected({ controlSessionId: sessionId, adapterId }),
        transitionToSpeaking: (sessionId: string, adapterId: string) =>
          runtimeMachine.transitionToSpeaking({ controlSessionId: sessionId, adapterId }),
        transitionToEnding: (sessionId: string, adapterId: string) =>
          runtimeMachine.transitionToEnding({ controlSessionId: sessionId, adapterId }),
        transitionToDisconnected: (sessionId: string, adapterId: string, error: unknown | null) =>
          runtimeMachine.transitionToDisconnected({
            controlSessionId: sessionId,
            adapterId,
            error: error as Parameters<typeof runtimeMachine.transitionToDisconnected>[0]['error'],
          }),
        setError: (sessionId: string, adapterId: string, error: unknown) =>
          runtimeMachine.setError({
            controlSessionId: sessionId,
            adapterId,
            error: error as Parameters<typeof runtimeMachine.setError>[0]['error'],
          }),
        setMuted: runtimeMachine.setMuted,
        getSnapshot: runtimeMachine.getSnapshot,
        projectSnapshot: (adapterId: string, snapshot: unknown) =>
          deriveLocalVoiceSessionSnapshot(
            adapterId,
            'realtime',
            snapshot as Parameters<typeof deriveLocalVoiceSessionSnapshot>[2],
          ),
        subscribe: (listener: () => void) =>
          useVoiceConversationRuntimeStore.subscribe(() => listener()),
      },
      createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
        controllerInput = input;
        return createVoiceConversationController(input);
      }),
      createMicSession: vi.fn(() => mic),
      createSdkHandleConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebRtcConnection: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmMedia: vi.fn(() => { throw new Error('unused'); }),
      createWebSocketPcmConnection: vi.fn(() => { throw new Error('unused'); }),
      ensureBound: vi.fn(async () => undefined),
      acquireDirectMediaConversation: vi.fn(async () => {
        carrierAcquisitionCount += 1;
        if (carrierAcquisitionCount === 1) await firstCarrierAcquisition.promise;
        return { conversationSessionId: controlSessionId };
      }),
      releaseDirectMediaConversation,
      resolveConversationSessionId: vi.fn(() => controlSessionId),
      applyTargetSelection: vi.fn(async () => undefined),
      acquireAudioMode: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
      createStorageMirror: vi.fn(() => vi.fn()),
      openLevelWriter: vi.fn(() => ({
        write: vi.fn(),
        reset: vi.fn(),
        close: vi.fn(),
      })),
      projectTranscript,
      beginTranscriptAttempt: vi.fn(() => ++transcriptEpoch),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({
        run: vi.fn(async () => ({ status: 'submitted' as const })),
        cancel: vi.fn(),
        dispose: vi.fn(),
      })),
      voiceHooks: {
        onStarted: vi.fn(() => ''),
        onStopped,
      },
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
        prepare: vi.fn(async () => {
          preparationSequence += 1;
          return {
            kind: 'prepared' as const,
            session: { config: { preparationSequence }, safeMetadata: null },
          };
        }),
        releasePrepared,
        decodeControl: vi.fn(() => []),
        encodeTurnControl: vi.fn(() => null),
      },
      createConnection,
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
      requiresMicForConnection: true,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn((text: string) => [{ type: 'input_text', text }]),
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    let staleStop: Promise<void> | null = null;

    try {
      const firstStart = runtime.adapter.start({ sessionId: controlSessionId });
      await vi.waitFor(() => expect(host.acquireDirectMediaConversation).toHaveBeenCalledTimes(1));
      expect(micActive).toBe(false);
      expect(host.beginTranscriptAttempt).not.toHaveBeenCalled();
      firstCarrierAcquisition.resolve();
      await firstStart;
      staleStop = runtime.adapter.stop({ sessionId: controlSessionId });
      await vi.waitFor(() => expect(connections.get(1)?.state()).toBe('open'));

      await runtime.adapter.start({ sessionId: controlSessionId });
      expect(runtimeMachine.getSnapshot()).toMatchObject({
        adapterId: providerId,
        controlSessionId,
        state: 'connected',
      });
      expect(micActive).toBe(true);
      expect(activeProviderPreparation).toBe(2);
      expect(onStopped).not.toHaveBeenCalled();

      staleConnectionClose.resolve();
      await staleStop;

      expect(runtimeMachine.getSnapshot()).toMatchObject({
        adapterId: providerId,
        controlSessionId,
        state: 'connected',
      });
      expect(mic.teardown).not.toHaveBeenCalled();
      expect(releaseDirectMediaConversation).not.toHaveBeenCalled();
      expect(activeProviderPreparation).toBe(2);
      expect(onStopped).not.toHaveBeenCalled();
      expect(() => controllerInput!.projectTranscript?.({
        controlSessionId,
        attemptId: 2,
        connectionId: 1,
        event: {
          v: 1,
          epoch: 1,
          sequence: 1,
          revision: 1,
          eventId: 'replacement-b:final',
          role: 'user',
          type: 'voice.transcript.final',
          text: 'replacement B is still live',
          itemId: 'replacement-b',
          provenance: 'live',
        },
      })).not.toThrow();
      expect(projectTranscript).toHaveBeenCalledTimes(1);
      await expect(runtime.adapter.sendTextTurn?.({
        controlSessionId,
        conversationSessionId: controlSessionId,
        text: 'continue on B',
        localId: 'replacement-b-text',
        deliveryCommand: 'interrupt_and_send',
      })).resolves.toBeUndefined();
      expect(sendControlByAttempt.get(2)).toHaveBeenCalledWith({
        type: 'input_text',
        text: 'continue on B',
      });
    } finally {
      staleConnectionClose.resolve();
      await staleStop?.catch(() => {});
      await runtime.dispose();
      runtimeMachine.reset();
    }
  });

  it('keeps the host lifecycle owner while forwarding mute to provider-managed exclusive media', async () => {
    const setInputMuted = vi.fn(async () => undefined);
    const resolveConversationBinding = vi.fn(async (input: Readonly<{
      controlSessionId: string;
      requestedTargetSessionId: string | null;
      settings: unknown;
    }>) => ({
      controlSessionId: input.controlSessionId,
      conversationSessionId: input.controlSessionId,
      transcriptMode: 'native_session' as const,
      targetSessionId: input.requestedTargetSessionId,
    }));
    const releaseAudioMode = vi.fn(async () => undefined);
    const acquireAudioMode = vi.fn<BundledRealtimeProviderRuntimeHost['acquireAudioMode']>(
      async () => ({ release: releaseAudioMode }),
    );
    const mic = {
      ensureActive: vi.fn(async () => undefined),
      teardown: vi.fn(async () => undefined),
      setMuted: vi.fn(),
      isMuted: vi.fn(() => false),
      getStream: vi.fn(() => null),
      getAudioContext: vi.fn(() => null),
    };
    let selectedProviderId = 'realtime_sdk';
    let providerConfig: Readonly<Record<string, unknown>> = {
      authentication: { source: 'voice_saved_secret' },
    };
    let controllerInput: VoiceConversationControllerDeps | null = null;
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
      getOwnedControlSessionId: vi.fn(() => null),
      requestReconnect: vi.fn(async () => false),
      playbackCursorMs: vi.fn(() => null),
      beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    } satisfies VoiceConversationController;
    const host = {
      globalVoiceSessionId: 'voice-global',
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
        return controller;
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
      createStorageMirror: vi.fn(() => vi.fn()),
      openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
      projectTranscript: vi.fn(() => null),
      beginTranscriptAttempt: vi.fn(() => 1),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({ run: vi.fn(async () => ({ status: 'submitted' as const })), cancel: vi.fn(), dispose: vi.fn() })),
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
          stopSession: false, resumption: 'none', replay: 'none', exactMessage: true,
        },
        prepare: vi.fn(async () => ({ kind: 'declined' as const, code: 'unused' })),
        decodeControl: vi.fn(() => []),
        encodeTurnControl: vi.fn(() => null),
      },
      createConnection: vi.fn(async () => { throw new Error('unused'); }),
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
      requiresMicForConnection: false,
      setInputMuted,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveConversationBinding,
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    await runtime.adapter.start({ sessionId: 'voice-global' });

    await expect(runtime.adapter.resolveConversationBinding?.({
      controlSessionId: 'codex-session',
      requestedTargetSessionId: 'target-session',
      settings: { voice: true },
    })).resolves.toEqual({
      controlSessionId: 'codex-session',
      conversationSessionId: 'codex-session',
      transcriptMode: 'native_session',
      targetSessionId: 'target-session',
    });
    expect(resolveConversationBinding).toHaveBeenCalledTimes(1);

    const resources = controllerInput!.resources;
    if (!resources) throw new Error('expected runtime resources');
    await runtime.adapter.start({ sessionId: 'voice-global' });
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
    await resources.prepare({
      controlSessionId: 'voice-global', attemptId: 1, request: {}, signal: new AbortController().signal,
    });
    await runtime.adapter.setMuted({ sessionId: 'voice-global', muted: true });
    await resources.release({ controlSessionId: 'voice-global', attemptId: 1, reason: { code: 'user_stop' } });
    await runtime.adapter.stop({ sessionId: 'voice-global' });
    await runtime.adapter.start({ sessionId: 'voice-global' });

    expect(mic.ensureActive).not.toHaveBeenCalled();
    expect(host.acquireAudioMode).toHaveBeenCalledWith('realtime_sdk');
    expect(mic.setMuted).toHaveBeenCalledWith(true);
    expect(setInputMuted).toHaveBeenCalledWith(true);
    expect(host.machine.setMuted).toHaveBeenCalledWith(true);
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
    const targetSelection = createDeferredVoid();
    let controllerInput: VoiceConversationControllerDeps | null = null;
    const controllerStart = vi.fn<VoiceConversationController['start']>(async (input) => {
      controllerInput!.machine.connected({
        controlSessionId: input.controlSessionId,
        attemptId: 1,
      });
      return { status: 'connected' };
    });
    const controllerStop = vi.fn(async () => undefined);
    const controller = {
      start: controllerStart,
      stop: controllerStop,
      fail: vi.fn(async () => undefined),
      performTurnControl: vi.fn(async () => ({
        status: 'unavailable' as const,
        code: 'voice_turn_action_unsupported' as const,
      })),
      sendClientControl: vi.fn(async () => ({ status: 'sent' as const })),
      getActiveControlSessionId: vi.fn(() => null),
      getOwnedControlSessionId: vi.fn(() => null),
      requestReconnect: vi.fn(async () => false),
      playbackCursorMs: vi.fn(() => null),
      beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    } satisfies VoiceConversationController;
    const host = {
      globalVoiceSessionId: 'voice-global',
      getPlatform: () => 'web' as const,
      getRealtimeClientToolDefinitions: () => [],
      getSettings: () => ({ voice: { providerId: 'realtime_test' } }),
      projectVoiceSettings: () => ({ providerId: 'realtime_test', providerConfig: {} }),
      machine: {
        transitionToAcquiringMic: vi.fn(), transitionToConnecting: vi.fn(), transitionToConnected: vi.fn(),
        setReconnecting: vi.fn(), transitionToSpeaking: vi.fn(), transitionToEnding: vi.fn(),
        transitionToDisconnected: vi.fn(), setError: vi.fn(), setMuted: vi.fn(),
        getSnapshot: vi.fn(() => ({ status: 'disconnected' })),
        projectSnapshot: vi.fn(() => ({
          adapterId: 'realtime_test',
          sessionId: null,
          status: 'disconnected' as const,
          mode: 'idle' as const,
          canStop: false,
        })),
        subscribe: vi.fn(() => vi.fn()),
      },
      createConversationController: vi.fn((input: VoiceConversationControllerDeps) => {
        controllerInput = input;
        return controller;
      }),
      createMicSession: vi.fn(() => ({
        ensureActive: vi.fn(async () => undefined),
        teardown: vi.fn(async () => undefined),
        setMuted: vi.fn(),
        isMuted: vi.fn(() => false),
        getStream: vi.fn(() => null),
        getAudioContext: vi.fn(() => null),
      })),
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
      applyTargetSelection: vi.fn(async () => await targetSelection.promise),
      acquireAudioMode: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
      createStorageMirror: vi.fn(() => vi.fn()),
      openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
      projectTranscript: vi.fn(() => null),
      beginTranscriptAttempt: vi.fn(() => 1),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn(() => ({
        run: vi.fn(async () => ({ status: 'submitted' as const })),
        cancel: vi.fn(),
        dispose: vi.fn(),
      })),
      voiceHooks: { onStarted: vi.fn(() => 'context'), onStopped: vi.fn() },
      createMachineError: vi.fn((input) => ({
        ...input,
        phase: 'runtime' as const,
        retryPolicy: 'user_action' as const,
        recoveryAction: 'retry' as const,
        presentation: 'error' as const,
        recoverable: true,
      })),
    } satisfies BundledRealtimeProviderRuntimeHost;
    const runtime = createBundledRealtimeProviderRuntime(host, {
      providerId: 'realtime_test',
      execution: { kind: 'direct_media' },
      protocol: {
        id: 'realtime_test',
        turnControls: {
          cancelResponse: 'unsupported',
          truncatePlayback: 'unsupported',
          clearInput: false,
          stopSession: false,
          resumption: 'none',
          replay: 'none',
          exactMessage: true,
        },
        prepare: vi.fn(async () => ({ kind: 'declined' as const, code: 'unused' })),
        decodeControl: vi.fn(() => []),
        encodeTurnControl: vi.fn(() => null),
      },
      createConnection: vi.fn(async () => { throw new Error('unused'); }),
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
      requiresMicForConnection: false,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveSurfaceCapabilities: vi.fn(() => null),
    });

    const starting = runtime.adapter.start({ sessionId: 'target-session' });
    await Promise.resolve();
    expect(host.applyTargetSelection).toHaveBeenCalledWith({
      controlSessionId: 'target-session',
      targetSessionId: 'target-session',
      updateLastFocused: true,
    });

    await runtime.adapter.stop({ sessionId: 'target-session' });
    expect(controllerStop).toHaveBeenCalledTimes(1);
    expect(controllerStart).not.toHaveBeenCalled();
    expect(host.machine.transitionToConnected).not.toHaveBeenCalled();

    targetSelection.resolve();
    await starting;

    expect(controllerStart).not.toHaveBeenCalled();
    expect(controllerStop).toHaveBeenCalledTimes(1);
    expect(host.machine.transitionToConnected).not.toHaveBeenCalled();
    expect(host.voiceHooks.onStarted).not.toHaveBeenCalled();
  });

  it('owns generic lifecycle/resources/tool barrier without provider-id policy branches', async () => {
    markAssistantInterrupted.mockClear();
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
    const webRtcConnection = {
      state: () => 'open',
      close: vi.fn(async () => undefined),
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
    const driver = Object.freeze({});
    const negotiatedWebRtc = Object.freeze({
      signaling: Object.freeze({
        exchangeOffer: vi.fn(async () => ({ answerSdp: 'v=0\r\n' })),
      }),
      control: Object.freeze({ label: 'events', onOpen: vi.fn() }),
    });
    let failAfterPcmCreation = false;
    const createConnection = vi.fn(async (input: unknown) => {
      const media = (input as Readonly<{
        attemptId: number;
        media: Readonly<{
          createWebRtcConnection(input: typeof negotiatedWebRtc): VoiceRealtimeConnection;
          createPcmConnection(input: Readonly<{
            driver: unknown;
            input: Readonly<{ sampleRate: number; chunkMs: number }>;
            output: Readonly<{ sampleRate: number; maxBufferedMs: number }>;
            onInputChunk(base64Pcm16Le: string): void;
            onInputError?(code: string): void;
          }>): Readonly<{
            connection: VoiceRealtimeConnection;
            enqueueOutput(base64Pcm16Le: string): boolean;
            clearOutput(): void;
            waitForOutputDrain(signal: AbortSignal): Promise<void>;
          }>;
        }>;
      }>).media;
      const attemptId = (input as Readonly<{ attemptId: number }>).attemptId;
      if (attemptId === 7) return media.createWebRtcConnection(negotiatedWebRtc);
      const publicPcm = media.createPcmConnection({
        driver,
        input: { sampleRate: 24_000, chunkMs: 100 },
        output: { sampleRate: 24_000, maxBufferedMs: 5_000 },
        onInputChunk: vi.fn(),
        onInputError: vi.fn(),
      });
      expect(publicPcm.connection).toBe(pcmConnection);
      expect(publicPcm.enqueueOutput('AQI=')).toBe(true);
      publicPcm.clearOutput();
      await publicPcm.waitForOutputDrain(new AbortController().signal);
      if (failAfterPcmCreation) throw new Error('provider_connection_creation_failed');
      return pcmConnection;
    });
    const releaseAudioMode = vi.fn(async () => undefined);
    let interruptionPolicy: 'client_two_stage' | 'provider_immediate' = 'client_two_stage';
    const hostMedia = {
      createSdkHandleConnection,
      createWebRtcConnection,
      createWebSocketPcmMedia,
      createWebSocketPcmConnection,
    };
    const host = {
      globalVoiceSessionId: 'voice-global',
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
          start,
          stop,
          fail,
          performTurnControl,
          sendClientControl,
          getActiveControlSessionId: vi.fn(() => 'voice-global'),
          getOwnedControlSessionId: vi.fn(() => 'voice-global'),
          requestReconnect: vi.fn(async () => true),
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
      acquireDirectMediaConversation: vi.fn(() => ({
        conversationSessionId: 'session-1',
      })),
      releaseDirectMediaConversation: vi.fn(),
      resolveConversationSessionId: vi.fn(() => 'session-1'),
      applyTargetSelection: vi.fn(),
      acquireAudioMode: vi.fn(async () => ({ release: releaseAudioMode })),
      createStorageMirror: vi.fn(() => vi.fn()),
      projectTranscript: vi.fn(({ event }: Readonly<{ event: unknown }>) => {
        const transcript = event as Readonly<{ role?: unknown; type?: unknown; itemId?: unknown }>;
        return transcript.role === 'assistant'
          && transcript.type === 'voice.transcript.final'
          && transcript.itemId === 'assistant-1'
          ? 'persisted-assistant-1'
          : null;
      }),
      beginTranscriptAttempt: vi.fn(() => 1),
      presentHostedLeaseNotice: vi.fn(),
      presentAttemptDiagnostic: vi.fn(),
      clearAttemptStatus: vi.fn(),
      createToolBarrier: vi.fn((input: Parameters<BundledRealtimeProviderRuntimeHost['createToolBarrier']>[0]) => {
        barrierInput = input;
        return { run: vi.fn(async () => ({ status: 'submitted' as const })), cancel: vi.fn(), dispose: vi.fn() };
      }),
      voiceHooks: { onStarted: vi.fn(() => 'context'), onStopped: vi.fn() },
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
          replay: 'none' as const,
          exactMessage: true,
        },
        prepare, decodeControl: vi.fn(), encodeTurnControl: vi.fn(),
      },
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
    await runtime.adapter.start({ sessionId: 'session-1' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ controlSessionId: 'session-1' }));
    expect(host.voiceHooks.onStarted).toHaveBeenCalledWith('session-1');
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
    expect(createWebSocketPcmMedia).toHaveBeenCalledWith(expect.objectContaining({
      mic,
      input: { sampleRate: 24_000, chunkMs: 100 },
      output: {
        sampleRate: 24_000,
        maxBufferedMs: 5_000,
        retainedOutputMaxMs: expect.any(Number),
      },
      onOutputLevel: expect.any(Function),
    }));
    expect(createWebSocketPcmConnection).toHaveBeenCalledWith({ driver, pcm: pcmMedia.pcm });
    expect(pcmMedia.enqueueOutput).toHaveBeenCalledWith('AQI=');
    expect(pcmMedia.clearOutput).toHaveBeenCalledTimes(1);
    expect(pcmMedia.waitForOutputDrain).toHaveBeenCalledTimes(1);
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
    expect(createWebRtcConnection).toHaveBeenCalledTimes(1);
    const cancelledAttempt = new AbortController();
    cancelledAttempt.abort();
    await expect(createControllerConnection(
      { config: null, safeMetadata: null },
      9,
      cancelledAttempt.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(createConnection).toHaveBeenCalledTimes(2);
    await runtimeEvents.onCanonicalEvent({ type: 'assistant_output_started', itemId: 'assistant-1' });
    await controllerInput!.resources!.preflight?.({
      controlSessionId: 'session-1',
      attemptId: 1,
      request: {},
      signal: new AbortController().signal,
    });
    await controllerInput!.resources!.prepare({
      controlSessionId: 'session-1',
      attemptId: 1,
      request: { textOnly: true },
      signal: new AbortController().signal,
    });
    expect(host.beginTranscriptAttempt).toHaveBeenCalledWith({ conversationSessionId: 'session-1' });
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
    expect(host.projectTranscript).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'session-1',
      source: {
        pluginId: 'happier.voice.test',
        contributionId: 'realtime-example',
      },
      event: {
        v: 1,
        epoch: 1,
        sequence: 1,
        revision: 1,
        eventId: 'assistant-1:final',
        role: 'assistant',
        type: 'voice.transcript.final',
        text: 'the current response',
        itemId: 'assistant-1',
        provenance: 'live',
      },
    });
    expect(host.projectTranscript).toHaveBeenNthCalledWith(2, {
      conversationSessionId: 'session-1',
      source: {
        pluginId: 'happier.voice.test',
        contributionId: 'realtime-example',
      },
      event: {
        v: 1,
        epoch: 1,
        sequence: 2,
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
    await vi.waitFor(() => expect(markAssistantInterrupted).toHaveBeenCalledWith({
      conversationSessionId: 'session-1',
      assistantEntryId: 'persisted-assistant-1',
    }));
    expect(interruptOrder).toEqual([
      'local-output-cleared',
      'cancel_response',
      'remote-output-cleared',
    ]);
    interruptOrder.length = 0;
    sentEvents.length = 0;
    await runtimeEvents.onCanonicalEvent({ type: 'assistant_output_stopped' });
    expect(attemptTwoWriter.reset).toHaveBeenCalledTimes(1);
    failAfterPcmCreation = true;
    await expect(createControllerConnection(
      { config: null, safeMetadata: null },
      10,
      new AbortController().signal,
    )).rejects.toThrow('provider_connection_creation_failed');
    expect(closePcmConnection).toHaveBeenCalledWith({
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
        reconnecting(input: Readonly<{ controlSessionId: string; active: boolean }>): void;
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
    controllerProtocol.machine.reconnecting({ controlSessionId: 'voice-global', active: true });
    expect(host.machine.setReconnecting).toHaveBeenCalledWith('voice-global', 'realtime_example', true);
    controllerProtocol.machine.disconnected({ controlSessionId: 'voice-global', code: 'credential_unavailable' });
    expect(inputLevelWriter.close).toHaveBeenCalledTimes(1);
    expect(attemptTwoWriter.close).toHaveBeenCalledTimes(1);
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_unavailable',
    });
    controllerProtocol.machine.disconnected({
      controlSessionId: 'voice-global',
      code: 'credential_access_review_required',
    });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_auth_invalid',
      reason: 'credential_access_review_required',
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
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'provider_specific_failure' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_error',
      reason: 'provider_specific_failure',
    });
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'update_required' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'update_required',
      reason: 'update_required',
    });
    const onConnectionReady = (controllerInput as unknown as Readonly<{
      onConnectionReady(input: Readonly<{
        request: VoiceRealtimeJsonValue;
        connection: Readonly<{ sendControl(event: VoiceRealtimeJsonValue): Promise<void> }>;
        signal: AbortSignal;
      }>): Promise<void>;
    }>).onConnectionReady;
    await onConnectionReady({
      request: { initialContext: 'context' },
      connection: { sendControl: async (event) => { sentEvents.push(event); } },
      signal: new AbortController().signal,
    });
    expect(sentEvents).toEqual([{ type: 'session.update', text: 'context' }]);
    sentEvents.length = 0;
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
      requestedTargetSessionId: null,
    });
    await runtime.adapter.stop({ sessionId: 'session-1' });
    await runtime.adapter.start({ sessionId: 'session-1' });
    let resolveLateMic!: () => void;
    mic.ensureActive.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveLateMic = resolve;
    }));
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
    await runtime.adapter.start({ sessionId: 'session-1' });
    mic.ensureActive.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { name: 'NotAllowedError' }));
    await expect(resources.prepare({
      controlSessionId: 'session-1',
      attemptId: 3,
      request: {},
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'declined', code: 'mic_permission_denied' });

    const createToolBarrier = (controllerInput as unknown as Readonly<{
      createToolBarrier(): Readonly<{
        submitResults(responseId: string, results: readonly unknown[], signal: AbortSignal): Promise<void>;
        continueResponse(responseId: string, signal: AbortSignal): Promise<void>;
      }>;
    }>).createToolBarrier;
    createToolBarrier();
    const barrier = barrierInput!;
    const signal = new AbortController().signal;
    await barrier.submitResults('response-1', [], signal);
    await barrier.continueResponse('response-1', signal);
    expect(sentEvents).toEqual([
      { type: 'tool.output' },
      'playback-drained',
      { type: 'response.create' },
    ]);

    sentEvents.length = 0;
    await runtime.adapter.sendTextTurn!({ controlSessionId: 'voice-global', conversationSessionId: 'session-1', text: 'hello', localId: 'voice-local-1', deliveryCommand: 'interrupt_and_send' });
    expect(sentEvents).toEqual([
      { type: 'conversation.item.create', text: 'hello' },
      { type: 'response.create' },
    ]);
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

    start.mockResolvedValueOnce({ status: 'failed', code: 'voice_context_update_failed' });
    await expect(runtime.adapter.start({ sessionId: 'session-2' })).rejects.toMatchObject({
      message: 'voice_context_update_failed',
      code: 'voice_context_update_failed',
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(3);

    start.mockResolvedValueOnce({ status: 'failed', code: 'machine unavailable at /Users/private/repository' });
    await expect(runtime.adapter.start({ sessionId: 'session-unsafe-code' })).rejects.toMatchObject({
      message: 'voice_connection_failed',
      code: 'voice_connection_failed',
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(4);

    start.mockResolvedValueOnce({ status: 'declined', code: 'credential_unavailable' });
    await expect(runtime.adapter.start({ sessionId: 'session-3' })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(5);

    await runtime.dispose();
    expect(stop).toHaveBeenCalledTimes(3);
  });
});
