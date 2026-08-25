import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';
import type {
  BundledRetiringDirectMediaTranscriptDrain,
  BundledRealtimeProviderRuntimeHost,
} from '@/voice/registry/bundledConversationRuntimeContract';
import type {
  VoiceRealtimeConnection,
  VoiceTurnControlAction,
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

import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';

const markAssistantInterrupted = vi.hoisted(() => vi.fn());
vi.mock('@/voice/transcript/voiceTurnInterruption', () => ({
  markVoiceConversationAssistantTurnInterrupted: markAssistantInterrupted,
}));

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy, warn: vi.fn(), error: vi.fn() } }));

function createDeferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runCurrentGenerationEffect(callback: () => void): boolean {
  callback();
  return true;
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
    const carrierReleases = [createDeferredVoid(), createDeferredVoid()];
    const releaseDirectMediaConversation = vi.fn(async () => {
      await carrierReleases[releaseDirectMediaConversation.mock.calls.length - 1]?.promise;
    });
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
      runCurrentGenerationEffect,
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
          runtimeMachine.setMuted({
            controlSessionId: sessionId,
            adapterId,
            attemptId,
            micMuted: muted,
          }),
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
      openLevelWriter: vi.fn(() => ({
        write: vi.fn(),
        reset: vi.fn(),
        close: vi.fn(),
      })),
      projectTranscript,
      admitTranscriptPersistenceEvent: vi.fn(() => null),
      commitAdmittedTranscriptPersistenceEvent: vi.fn(() => null),
      releaseAdmittedTranscriptPersistenceEvent: vi.fn(() => false),
      settleTranscriptPersistence: vi.fn(async () => undefined),
      beginTranscriptAttempt: vi.fn(() => {
        transcriptEpoch += 1;
        return {
          epoch: transcriptEpoch,
          attemptIdentity: `attempt-${transcriptEpoch}`,
        };
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
      microphoneMode: 'host_webrtc',
      createConnection,
      encodeToolResults: vi.fn(() => []),
      encodeToolContinuation: vi.fn(() => ({ type: 'unused' })),
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
      await vi.waitFor(() => {
        expect(host.releaseDirectMediaConversation).toHaveBeenCalledTimes(1);
      });
      let staleStopSettled = false;
      void staleStop.then(() => {
        staleStopSettled = true;
      });
      await Promise.resolve();
      expect(staleStopSettled).toBe(false);

      expect(runtimeMachine.getSnapshot()).toMatchObject({
        adapterId: providerId,
        controlSessionId,
        state: 'connected',
      });
      expect(mic.teardown).not.toHaveBeenCalled();
      expect(releaseDirectMediaConversation).toHaveBeenCalledExactlyOnceWith({
        adapterId: providerId,
        controlSessionId,
        conversationSessionId: controlSessionId,
        transcriptAttemptIdentity: 'attempt-1',
      });
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
        onAccepted: async () => {},
      })).resolves.toBeUndefined();
      expect(sendControlByAttempt.get(2)).toHaveBeenCalledWith({
        type: 'input_text',
        text: 'continue on B',
      });
      carrierReleases[0]!.resolve();
      await staleStop;
      const activeStop = runtime.adapter.stop({ sessionId: controlSessionId });
      await vi.waitFor(() => {
        expect(releaseDirectMediaConversation).toHaveBeenCalledTimes(2);
      });
      let activeStopSettled = false;
      void activeStop.then(() => {
        activeStopSettled = true;
      });
      await Promise.resolve();
      expect(activeStopSettled).toBe(false);
      expect(micActive).toBe(false);
      expect(mic.teardown).toHaveBeenCalledTimes(1);
      expect(runtimeMachine.getSnapshot()).toMatchObject({
        adapterId: providerId,
        controlSessionId,
        state: 'disconnected',
      });
      expect(onStopped).not.toHaveBeenCalled();
      carrierReleases[1]!.resolve();
      await activeStop;
      expect(onStopped).toHaveBeenCalledTimes(1);
    } finally {
      staleConnectionClose.resolve();
      for (const release of carrierReleases) release.resolve();
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
      getOwnedControlSessionId: vi.fn(() => 'voice-global'),
      getOwnedAttemptId: vi.fn(() => 1),
      requestReconnect: vi.fn(async () => false),
      playbackCursorMs: vi.fn(() => null),
      beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    } satisfies VoiceConversationController;
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
      createToolBarrier: vi.fn(() => ({ run: vi.fn(async () => ({ status: 'submitted' as const })), detach: vi.fn(), cancel: vi.fn(), dispose: vi.fn() })),
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
      microphoneMode: 'provider_managed',
      setInputMuted,
      encodeContextUpdate: vi.fn(() => []),
      encodeTextTurn: vi.fn(() => []),
      resolveConversationBinding,
      resolveSurfaceCapabilities: vi.fn(() => null),
    });
    await runtime.adapter.start({ sessionId: 'voice-global' });
    expect(openLevelWriter).toHaveBeenCalledWith({
      channel: 'input',
      sourceId: 'realtime_sdk:voice-global',
    });
    expect(providerManagedInputWriter.close).not.toHaveBeenCalled();
    await expect(runtime.adapter.sendTextTurn?.({
      controlSessionId: 'voice-global',
      conversationSessionId: 'voice-global',
      text: 'unsupported typed turn',
      localId: 'voice-local-unsupported',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => {},
    })).rejects.toThrow('voice_text_turn_unsupported');

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
      getOwnedAttemptId: vi.fn(() => null),
      requestReconnect: vi.fn(async () => false),
      playbackCursorMs: vi.fn(() => null),
      beginOutputInterruptionCandidate: vi.fn(() => 'unsupported' as const),
      resolveOutputInterruptionCandidate: vi.fn(),
    } satisfies VoiceConversationController;
    const host = {
      globalVoiceSessionId: 'voice-global',
      runCurrentGenerationEffect,
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
      openLevelWriter: vi.fn(() => ({ write: vi.fn(), reset: vi.fn(), close: vi.fn() })),
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
      createToolBarrier: vi.fn(() => ({
        run: vi.fn(async () => ({ status: 'submitted' as const })),
        detach: vi.fn(),
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
      microphoneMode: 'provider_managed',
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
          start,
          stop,
          fail,
          performTurnControl,
          sendClientControl,
          getActiveControlSessionId,
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
        return { run: vi.fn(async () => ({ status: 'submitted' as const })), detach: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
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
        toolEffectCalls: 'stable_ids' as const,
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
    await runtime.adapter.start({ sessionId: 'session-1' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ controlSessionId: 'session-1' }));
    if (!runtime.adapter.retry) throw new Error('realtime retry route unavailable');
    await runtime.adapter.retry({ sessionId: 'stale-session-id' });
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
    resolvedConversationSessionId = null;
    logSpy.mockClear();
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
    expect(logSpy).not.toHaveBeenCalled();
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
    expect(markAssistantInterrupted).not.toHaveBeenCalled();
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
    expect(markAssistantInterrupted).not.toHaveBeenCalled();
    releaseTranscriptPersistence.resolve();
    await vi.waitFor(() => expect(markAssistantInterrupted).toHaveBeenCalledWith({
      conversationSessionId: 'session-2',
      assistantEntryId: 'persisted-assistant-1',
    }));
    expect(captureRetiringDirectMediaTranscriptDrain).toHaveBeenCalledTimes(1);
    expect(markAssistantInterrupted).toHaveBeenCalledTimes(1);
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
    logSpy.mockClear();
    controllerProtocol.machine.failed({ controlSessionId: 'voice-global', code: 'provider_specific_failure' });
    expect(host.createMachineError).toHaveBeenLastCalledWith({
      kind: 'provider_error',
      reason: 'provider_specific_failure',
    });
    // Flattening an unknown code into `provider_error` renders as the single
    // generic "Connection Error"; the typed reason must survive in the log.
    const flattenedLog = String(logSpy.mock.calls.at(-1)?.[0]);
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
    expect(barrier).toMatchObject({ effectCalls: 'stable_ids' });
    const signal = new AbortController().signal;
    await barrier.submitResults('response-1', [], signal);
    await barrier.continueResponse('response-1', signal);
    expect(sentEvents).toEqual([
      { type: 'tool.output' },
      'playback-drained',
      { type: 'response.create' },
    ]);

    sentEvents.length = 0;
    await expect(runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-1',
      text: 'stale carrier text',
      localId: 'voice-local-stale',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => {},
    })).rejects.toMatchObject({
      message: 'voice_transcript_carrier_changed',
      code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
      pendingDeliveryBlockedReason: 'provider_rejected_before_acceptance',
    });
    expect(sentEvents).toEqual([]);

    host.settleTranscriptPersistence.mockImplementationOnce(async () => {
      sentEvents.push('transcript-drained');
    });
    await runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'hello',
      localId: 'voice-local-1',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => { sentEvents.push('pending-settled'); },
    });
    expect(sentEvents).toEqual([
      { type: 'conversation.item.create', text: 'hello' },
      'transcript-drained',
      'pending-settled',
      { type: 'response.create' },
    ]);

    sentEvents.length = 0;
    let releaseFirstSettlement!: () => void;
    const firstSettlement = new Promise<void>((resolve) => {
      releaseFirstSettlement = resolve;
    });
    host.settleTranscriptPersistence.mockImplementationOnce(async () => {
      await firstSettlement;
    });
    const firstTypedTurn = runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'first overlapping turn',
      localId: 'voice-local-overlap-1',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => { sentEvents.push('first-settled'); },
    });
    await vi.waitFor(() => {
      expect(sentEvents).toEqual([
        { type: 'conversation.item.create', text: 'first overlapping turn' },
      ]);
    });
    const secondTypedTurn = runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'second overlapping turn',
      localId: 'voice-local-overlap-2',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => { sentEvents.push('second-settled'); },
    });
    await Promise.resolve();
    expect(sentEvents).toEqual([
      { type: 'conversation.item.create', text: 'first overlapping turn' },
    ]);
    releaseFirstSettlement();
    await Promise.all([firstTypedTurn, secondTypedTurn]);
    expect(sentEvents).toEqual([
      { type: 'conversation.item.create', text: 'first overlapping turn' },
      'first-settled',
      { type: 'response.create' },
      { type: 'conversation.item.create', text: 'second overlapping turn' },
      'second-settled',
      { type: 'response.create' },
    ]);

    const acceptedSentEventCount = sentEvents.length;
    sendClientControl.mockResolvedValueOnce({
      status: 'unavailable',
      code: 'voice_connection_not_open',
    });
    await expect(runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'not accepted',
      localId: 'voice-local-rejected',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => {},
    })).rejects.toThrow('voice_service_unavailable');
    expect(sentEvents).toHaveLength(acceptedSentEventCount);
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
    let releaseStoppedTurnSettlement!: () => void;
    const stoppedTurnSettlement = new Promise<void>((resolve) => {
      releaseStoppedTurnSettlement = resolve;
    });
    host.settleTranscriptPersistence.mockImplementationOnce(async () => {
      await stoppedTurnSettlement;
    });
    const acceptedBeforeStop = vi.fn(async () => {});
    const turnAcceptedBeforeStop = runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'accepted before stop',
      localId: 'voice-local-stop-1',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: acceptedBeforeStop,
    });
    await vi.waitFor(() => {
      expect(sentEvents).toEqual([
        { type: 'conversation.item.create', text: 'accepted before stop' },
      ]);
    });
    const queuedBeforeStop = runtime.adapter.sendTextTurn!({
      controlSessionId: 'session-1',
      conversationSessionId: 'session-2',
      text: 'must not revive after stop',
      localId: 'voice-local-stop-2',
      deliveryCommand: 'interrupt_and_send',
      onAccepted: async () => { sentEvents.push('stale-queued-settled'); },
    });
    let queuedBeforeStopSettled = false;
    void queuedBeforeStop.catch(() => {
      queuedBeforeStopSettled = true;
    });
    const startCallsBeforeStop = start.mock.calls.length;
    await runtime.adapter.stop({ sessionId: 'session-1' });
    getActiveControlSessionId.mockReturnValue(null);
    await Promise.resolve();
    expect(queuedBeforeStopSettled).toBe(true);
    releaseStoppedTurnSettlement();
    await expect(turnAcceptedBeforeStop).rejects.toThrow('voice_transcript_attempt_ownership_mismatch');
    await expect(queuedBeforeStop).rejects.toThrow('voice_transcript_attempt_ownership_mismatch');
    expect(acceptedBeforeStop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(startCallsBeforeStop);
    expect(sentEvents).toEqual([
      { type: 'conversation.item.create', text: 'accepted before stop' },
    ]);

    start.mockResolvedValueOnce({ status: 'failed', code: 'voice_context_update_failed' });
    await expect(runtime.adapter.start({ sessionId: 'session-2' })).rejects.toMatchObject({
      message: 'voice_context_update_failed',
      code: 'voice_context_update_failed',
    });
    expect(stop).toHaveBeenCalledTimes(3);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(4);

    start.mockResolvedValueOnce({ status: 'failed', code: 'machine unavailable at /Users/private/repository' });
    await expect(runtime.adapter.start({ sessionId: 'session-unsafe-code' })).rejects.toMatchObject({
      message: 'voice_connection_failed',
      code: 'voice_connection_failed',
    });
    expect(stop).toHaveBeenCalledTimes(3);
    expect(host.voiceHooks.onStopped).toHaveBeenCalledTimes(5);

    start.mockResolvedValueOnce({ status: 'declined', code: 'credential_unavailable' });
    await expect(runtime.adapter.start({ sessionId: 'session-3' })).resolves.toBeUndefined();
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
    logSpy.mockClear();
    start.mockResolvedValueOnce({ status: 'declined', code: 'voice_provider_not_selected' });
    await expect(runtime.adapter.start({ sessionId: 'session-4' })).resolves.toBeUndefined();
    const unsettledDecline = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(unsettledDecline).toContain('[voiceRuntimeFailure]');
    expect(unsettledDecline).toContain('voice_provider_not_selected');
    expect(unsettledDecline).toContain('realtime_example');

    // An aborted start that never reached a terminal machine error is the same
    // unexplainable outcome and must be nameable once.
    logSpy.mockClear();
    start.mockResolvedValueOnce({ status: 'aborted' });
    await expect(runtime.adapter.start({ sessionId: 'session-5' })).resolves.toBeUndefined();
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain('voice_start_not_settled');

    // A start the machine already named must not be reported twice.
    logSpy.mockClear();
    start.mockImplementationOnce(async () => {
      controllerProtocol.machine.disconnected({
        controlSessionId: 'session-6',
        code: 'realtime_byo_not_configured',
      });
      return { status: 'declined', code: 'realtime_byo_not_configured' };
    });
    await expect(runtime.adapter.start({ sessionId: 'session-6' })).resolves.toBeUndefined();
    expect(logSpy.mock.calls.filter(
      (call) => String(call[0]).includes('[voiceRuntimeFailure]'),
    )).toHaveLength(1);

    await runtime.dispose();
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it('names every refused authoritative transcript event exactly once per attempt', async () => {
    logSpy.mockClear();
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
        run: vi.fn(async () => ({ status: 'submitted' as const })), detach: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
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
          replay: 'none' as const, exactMessage: true,
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
    const transcriptDropRecords = () => logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('[voiceRuntimeFailure]') && line.includes('transcript_dropped'));

    try {
      // A targeted direct-media attempt whose carrier binding disappears mid-turn
      // cannot be re-acquired under a different identity. Refusing the write is
      // correct; destroying the user's authoritative words without a trace is not.
      await runtime.adapter.start({ sessionId: 'target-session' });
      const runtimeEvents = controllerInput as unknown as Readonly<{
        projectTranscript(input: Readonly<{
          controlSessionId: string; attemptId: number; connectionId: number; event: unknown;
        }>): void;
      }>;
      await controllerInput!.resources!.prepare({
        controlSessionId: 'target-session',
        attemptId: 1,
        request: { requestedTargetSessionId: 'carrier-1' },
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 1;
      logSpy.mockClear();
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
      await runtime.adapter.start({ sessionId: '' });
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
      logSpy.mockClear();
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
      logSpy.mockClear();
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
      await controllerInput!.resources!.release({
        controlSessionId: 'voice-global',
        attemptId: 2,
        reason: { code: 'user_stop' },
      });
      expect(releaseDirectMediaConversation.mock.calls.filter(
        ([input]) => (input as Readonly<{ conversationSessionId?: string }>).conversationSessionId === 'carrier-2',
      )).toHaveLength(1);
      expect(releaseAudioMode).toHaveBeenCalledTimes(1);
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
      await runtime.adapter.start({ sessionId: '' });
      await controllerInput!.resources!.prepare({
        controlSessionId: 'voice-global',
        attemptId: 3,
        request: {},
        signal: new AbortController().signal,
      });
      activeResourceAttemptId = 3;
      logSpy.mockClear();
      projectTranscript.mockClear();
      resolvedConversationSessionId = null;
      rebindFailure = new Error('carrier_recreation_unavailable');
      (controllerInput as unknown as typeof runtimeEvents).projectTranscript({
        controlSessionId: 'voice-global',
        attemptId: 3,
        connectionId: 1,
        event: authoritativeFinal('user-final-3'),
      });
      await vi.waitFor(() => expect(transcriptDropRecords()).toHaveLength(1));
      expect(transcriptDropRecords()[0]).toContain('transcript_carrier_rebind_failed');
      expect(projectTranscript).not.toHaveBeenCalled();

      // A late event after End Voice is fenced deliberately, but the fence is
      // still a lost authoritative word and is named once, not once per event.
      await runtime.adapter.stop({ sessionId: 'voice-global' });
      logSpy.mockClear();
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
      logSpy.mockClear();
      releaseAudioMode.mockClear();
      releaseDirectMediaConversation.mockClear();
      onStopped.mockClear();
      controllerStop.mockClear();
      await runtime.adapter.start({ sessionId: '' });
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
    } finally {
      pendingCarrierRebind?.resolve();
      releaseReboundCarrier.resolve();
      await runtime.dispose();
    }
  });
});
