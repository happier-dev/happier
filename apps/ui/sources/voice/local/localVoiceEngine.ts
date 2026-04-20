import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import {
  MissingGeminiApiKeyError,
  MissingSttBaseUrlError,
  recordedAudioTranscriptionController,
} from '@/voice/runtime/input/recordedAudioTranscriptionController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { deriveLocalVoiceRuntimeProjection } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  confirmVoiceCaptureStarted,
  surfaceRecoverableVoiceCaptureError,
  transitionVoiceRuntimeToIdle,
} from '@/voice/runtime/machine/voiceConversationRuntimeHelpers';
import {
  createLocalVoiceCaptureOwner,
  type LocalVoiceCaptureProvider,
} from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import type { TurnEndpointSignal } from '@/voice/runtime/input/TurnEndpointController';
import { createExpoAudioRecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import { appendVoiceConversationAssistantText } from '@/voice/transcript/voiceConversationTranscript';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { warmDaemonVoiceInferenceOnVoiceHomeAttach } from '@/voice/runtime/daemonInference/warmDaemonVoiceInferenceOnVoiceHomeAttach';

import {
  isHandsFreeDeviceSttEnabled,
  isHandsFreeLocalNeuralSttEnabled,
  isVoiceBargeInEnabled,
  isLocalVoiceProviderSelected,
  resolveAdaptiveInterruptionConfig,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
  resolveLocalConversationControlSessionId,
} from './localVoiceSettings';
import { sendVoiceTextTurn as sendVoiceTextTurnImpl } from './sendVoiceTextTurn';

let inFlight: Promise<void> | null = null;
let activeTurnAbortController: AbortController | null = null;
let activeTurnAbortSessionId: string | null = null;

type EndpointDrivenCaptureProvider = Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;

const playbackController = createVoicePlaybackController();
const localVoiceCaptureOwner = createLocalVoiceCaptureOwner({
  onCaptureStarted: (controlSessionId) => confirmVoiceCaptureStarted(controlSessionId),
  onCaptureError: (error) => surfaceRecoverableVoiceCaptureError(error),
  getSettings: () => storage.getState().settings as any,
  onEndpointSignal: (signal) => {
    handleRuntimeOwnedEndpointSignal(signal);
  },
}, {
  createRecordingMicSession: createExpoAudioRecordingMicSession,
  createDeviceSttController,
  createSherpaSttController: createSherpaStreamingSttController,
});

function getCurrentLocalRuntimeCompatState(): Readonly<{
  sessionId: string | null;
  status: ReturnType<typeof deriveLocalVoiceRuntimeProjection>['compatStatus'];
}> {
  const snapshot = voiceConversationRuntimeMachine.getSnapshot();
  return {
    sessionId: snapshot.controlSessionId,
    status: deriveLocalVoiceRuntimeProjection(snapshot).compatStatus,
  };
}

function resolveLocalVoiceCaptureProvider(settings: any): LocalVoiceCaptureProvider {
  const sttProvider = resolveLocalSttProvider(settings);
  if (sttProvider === 'device' || sttProvider === 'local_neural') {
    return sttProvider;
  }
  return 'recorded_audio';
}

async function ensureLocalConversationBindingForSession(settings: any, sessionId: string): Promise<void> {
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  if (adapterId !== 'local_conversation' || (config?.conversationMode ?? 'direct_session') !== 'agent') {
    return;
  }

  const controlSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  const requestedTargetSessionId =
    String(sessionId ?? '').trim() === VOICE_AGENT_GLOBAL_SESSION_ID ? null : String(sessionId ?? '').trim();
  await voiceSessionBindingManager.ensureBound({
    adapterId: 'local_conversation',
    controlSessionId,
    requestedTargetSessionId,
  });
}

function isHandsFreeCaptureEnabled(settings: any, provider: LocalVoiceCaptureProvider, config: any): boolean {
  return provider !== 'recorded_audio' && config?.handsFree?.enabled === true;
}

function isEndpointDrivenCaptureProvider(provider: LocalVoiceCaptureProvider): provider is EndpointDrivenCaptureProvider {
  return provider === 'device' || provider === 'local_neural';
}

function isHandsFreeEndpointLoopEnabled(settings: any, provider: EndpointDrivenCaptureProvider): boolean {
  return provider === 'device'
    ? isHandsFreeDeviceSttEnabled(settings)
    : isHandsFreeLocalNeuralSttEnabled(settings);
}

async function maybeRearmHandsFreeCapture(
  followUp: Readonly<{
    kind: 'none';
  } | {
    kind: 'rearm_capture';
    provider: EndpointDrivenCaptureProvider;
    sessionId: string;
  }>,
): Promise<boolean> {
  if (followUp.kind !== 'rearm_capture') {
    return false;
  }

  await voiceConversationRuntimeMachine.rearmListening({
    controlSessionId: followUp.sessionId,
    startListening: () => localVoiceCaptureOwner.startCapture({
      handsFree: true,
      provider: followUp.provider,
      sessionId: followUp.sessionId,
    }),
  });
  return true;
}

function beginEndpointDrivenStopAndSend(sessionId: string, provider: EndpointDrivenCaptureProvider): void {
  if (inFlight) {
    return;
  }

  const operation = stopSttAndSend(sessionId, provider).finally(() => {
    if (inFlight === operation) {
      inFlight = null;
    }
  });
  inFlight = operation;
}

function handleRuntimeOwnedEndpointSignal(signal: TurnEndpointSignal): void {
  const current = getCurrentLocalRuntimeCompatState();
  const settings = storage.getState().settings as any;
  const provider = resolveLocalVoiceCaptureProvider(settings);
  const endpointAction = localVoiceCaptureOwner.resolveEndpointSignalAction({
    currentSessionId: current.sessionId,
    currentStatus: current.status,
    handsFreeEnabled: isEndpointDrivenCaptureProvider(provider) && isHandsFreeEndpointLoopEnabled(settings, provider),
    inFlight: inFlight !== null,
    provider,
    signal,
  });
  if (endpointAction.kind !== 'stop_capture') {
    return;
  }

  beginEndpointDrivenStopAndSend(endpointAction.sessionId, endpointAction.provider);
}

function isUnsupportedVoiceAgentPrewarmError(error: unknown): boolean {
  const carrier: RpcErrorCarrier =
    error && typeof error === 'object'
      ? (error as RpcErrorCarrier)
      : { message: typeof error === 'string' ? error : undefined };
  return isRpcMethodNotAvailableError(carrier) || isRpcMethodNotFoundError(carrier);
}

function isAbortedVoiceTurnError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof Error && error.message === 'turn_aborted';
}

function isMicPermissionDeniedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('permission_denied');
}

async function startLocalVoiceCapture(args: Readonly<{
  sessionId: string;
  provider: LocalVoiceCaptureProvider;
  handsFree: boolean;
  interrupted?: boolean;
}>): Promise<void> {
  let startError: unknown = null;
  const startListening = async () => {
    try {
      await localVoiceCaptureOwner.startCapture({
        sessionId: args.sessionId,
        provider: args.provider,
        handsFree: args.handsFree,
      });
    } catch (error) {
      startError = error;
      throw error;
    }
  };

  if (args.interrupted) {
    await voiceConversationRuntimeMachine.interruptAndRearmListening({
      controlSessionId: args.sessionId,
      startListening,
    });
  } else {
    await voiceConversationRuntimeMachine.rearmListening({
      controlSessionId: args.sessionId,
      startListening,
    });
  }

  if (args.provider !== 'recorded_audio' || !startError) {
    return;
  }

  if (isMicPermissionDeniedError(startError)) {
    transitionVoiceRuntimeToIdle({
      controlSessionId: args.sessionId,
      reason: 'mic_permission_denied',
      kind: 'mic_permission_denied',
    });
    return;
  }

  transitionVoiceRuntimeToIdle({
    controlSessionId: args.sessionId,
    reason: 'recording_start_failed',
  });
  throw startError;
}

async function runVoiceTurnWithSendFailureHandling(
  sessionId: string,
  settings: any,
  runner: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  try {
    await runAbortableVoiceTurn(sessionId, runner);
  } catch (error) {
    if (isAbortedVoiceTurnError(error)) {
      return;
    }
    transitionVoiceRuntimeToIdle({
      controlSessionId: sessionId,
      reason: 'send_failed',
    });
    const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
    const shouldSwallowSendFailure = adapterId === 'local_conversation' && config?.conversationMode === 'agent';
    if (!shouldSwallowSendFailure) {
      throw error;
    }
    return;
  }
}

async function stopAndSendRecordedTurn(sessionId: string): Promise<void> {
  voiceConversationRuntimeMachine.transitionToTranscribing({ controlSessionId: sessionId });
  let uri: string | null = null;
  try {
    const stopped = await localVoiceCaptureOwner.stopCapture({
      sessionId,
      provider: 'recorded_audio',
    });
    uri = stopped.provider === 'recorded_audio' ? stopped.uri : null;
  } catch {
    transitionVoiceRuntimeToIdle({
      controlSessionId: sessionId,
      reason: 'recording_stop_failed',
    });
    return;
  }

  if (!uri) {
    transitionVoiceRuntimeToIdle({ controlSessionId: sessionId });
    return;
  }

  const settings = storage.getState().settings as any;
  let text: string | null = null;
  try {
    text = await recordedAudioTranscriptionController.transcribe({ sessionId, uri, settings });
  } catch (error) {
    if (error instanceof MissingSttBaseUrlError) {
      transitionVoiceRuntimeToIdle({
        controlSessionId: sessionId,
        reason: 'missing_stt_base_url',
      });
      throw error;
    }
    if (error instanceof MissingGeminiApiKeyError) {
      transitionVoiceRuntimeToIdle({
        controlSessionId: sessionId,
        reason: 'missing_stt_api_key',
      });
      throw error;
    }
    transitionVoiceRuntimeToIdle({
      controlSessionId: sessionId,
      reason: 'stt_failed',
    });
    return;
  }

  if (!text) {
    transitionVoiceRuntimeToIdle({ controlSessionId: sessionId });
    return;
  }

  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );
}

async function stopSttAndSend(sessionId: string, provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>): Promise<void> {
  voiceConversationRuntimeMachine.transitionToTranscribing({ controlSessionId: sessionId });

  const settings = storage.getState().settings as any;
  const endpointDecision = await localVoiceCaptureOwner.stopEndpointDrivenCapture({
    adaptiveConfig: resolveAdaptiveInterruptionConfig(settings),
    provider,
    sessionId,
  });

  if (endpointDecision.kind === 'ignore') {
    if (await maybeRearmHandsFreeCapture(endpointDecision.followUp)) {
      return;
    }
    transitionVoiceRuntimeToIdle({ controlSessionId: sessionId });
    return;
  }

  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: endpointDecision.transcript,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );

  if (await maybeRearmHandsFreeCapture(endpointDecision.followUp)) {
    return;
  }
}

export async function stopLocalVoiceAgent(sessionId: string): Promise<void> {
  localVoiceCaptureOwner.clearHandsFree({ sessionId, provider: 'device' });
  localVoiceCaptureOwner.clearHandsFree({ sessionId, provider: 'local_neural' });
  await voiceAgentSessions.stop(sessionId);
}

export async function resetLocalVoiceAgentPersistence(): Promise<void> {
  await resetVoiceAgentPersistenceState({
    stop: async () => await stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID),
  });
}

export function isLocalVoiceAgentActive(sessionId: string): boolean {
  return voiceAgentSessions.isActive(sessionId);
}

export function appendLocalVoiceAgentContextUpdate(sessionId: string, update: string): void {
  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  voiceAgentSessions.appendContextUpdate(resolvedSessionId, update);
}

function projectLocalVoiceAgentAssistantText(sessionId: string, text: string): void {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;

  const binding =
    voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: sessionId })
    ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const conversationSessionId = typeof binding?.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
  if (!conversationSessionId) return;

  appendVoiceConversationAssistantText({
    conversationSessionId,
    text: trimmed,
  });
}

export function announceLocalVoiceAgentAssistantText(sessionId: string, text: string): void {
  projectLocalVoiceAgentAssistantText(sessionId, text);
}

export async function sendLocalVoiceAgentTextTurn(sessionId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId: resolvedSessionId,
      settings,
      userText: trimmed,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );
}

export async function sendLocalVoiceAgentTextUpdate(sessionId: string, update: string): Promise<void> {
  const text = update.trim();
  if (!text) return;

  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId: resolvedSessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions: {
        sendTurn: (nextSessionId, userText, opts) =>
          voiceAgentSessions.sendInterruptingTextUpdate(nextSessionId, userText, opts),
      },
      signal,
    }),
  );
}

async function runAbortableVoiceTurn(sessionId: string, runner: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  if (activeTurnAbortController) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
  }
  activeTurnAbortController = controller;
  activeTurnAbortSessionId = sessionId;
  try {
    await runner(controller.signal);
  } finally {
    if (activeTurnAbortController === controller) {
      activeTurnAbortController = null;
      activeTurnAbortSessionId = null;
    }
  }
}

async function settleEndingTransition(
  controlSessionId: string,
  nextState: 'connected' | 'disconnected',
  work: () => Promise<void>,
): Promise<void> {
  voiceConversationRuntimeMachine.transitionToEnding({ controlSessionId });
  try {
    await work();
  } finally {
    if (nextState === 'disconnected') {
      voiceConversationRuntimeMachine.transitionToDisconnected({ controlSessionId });
      return;
    }
    voiceConversationRuntimeMachine.transitionToConnected({ controlSessionId });
  }
}

export async function abortLocalVoiceTurn(sessionId: string): Promise<void> {
  const current = getCurrentLocalRuntimeCompatState();
  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  if (!current.sessionId) return;
  if (current.sessionId !== resolvedSessionId) return;

  await settleEndingTransition(resolvedSessionId, 'connected', async () => {
    playbackController.interrupt();
    if (activeTurnAbortController && activeTurnAbortSessionId === resolvedSessionId) {
      try {
        activeTurnAbortController.abort();
      } catch {
        // ignore
      }
    }

    if (inFlight) {
      await inFlight.catch(() => {});
    }
  });
}

export async function setLocalVoiceMuted(sessionId: string, muted: boolean): Promise<void> {
  const current = getCurrentLocalRuntimeCompatState();
  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  if (!current.sessionId) return;
  if (current.sessionId !== resolvedSessionId) return;

  await localVoiceCaptureOwner.setMuted({ muted, sessionId: resolvedSessionId });
  voiceConversationRuntimeMachine.setMuted(muted);
}

export async function toggleLocalVoiceTurn(sessionId: string): Promise<void> {
  const initialSettings = storage.getState().settings as any;
  if (!isLocalVoiceProviderSelected(initialSettings)) {
    return;
  }
  const controlSessionId = resolveLocalConversationControlSessionId(initialSettings, sessionId);

  const realtimeSessionSnapshot = realtimeTransport.getSessionSnapshot();
  if (realtimeSessionSnapshot.status === 'connected' || realtimeSessionSnapshot.status === 'connecting') {
    // Avoid audio-session conflicts: local voice should not start while a realtime call is active.
    return;
  }

  const initialState = getCurrentLocalRuntimeCompatState();
  const { config: initialConfig } = resolveLocalVoiceAdapterSettings(initialSettings);
  const initialProvider = resolveLocalVoiceCaptureProvider(initialSettings);
  const initialBargeInDecision = localVoiceCaptureOwner.resolveManualBargeInAction({
    bargeInEnabled: isVoiceBargeInEnabled(initialSettings),
    currentSessionId: initialState.sessionId,
    currentStatus: initialState.status,
    handsFree: isHandsFreeCaptureEnabled(initialSettings, initialProvider, initialConfig),
    provider: initialProvider,
    requestedSessionId: controlSessionId,
  });

  if (initialBargeInDecision.kind === 'noop' && initialBargeInDecision.reason === 'barge_in_disabled') {
    return;
  }

  if (inFlight && initialBargeInDecision.kind !== 'interrupt_and_rearm') {
    await inFlight;
  }

  const current = getCurrentLocalRuntimeCompatState();
  const prewarmLocalVoiceAgentOnConnect = (params: Readonly<{ settings: any; config: any }>): void => {
    const { config } = params;
    if (config?.conversationMode !== 'agent' || config?.agent?.prewarmOnConnect !== true) return;

    fireAndForget(
      (async () => {
        const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
        const welcomeMode = config?.agent?.welcome?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
        const welcomeEnabled = config?.agent?.welcome?.enabled === true;
        const canSpeakWelcome = config?.tts?.autoSpeakReplies !== false;

        if (welcomeEnabled && welcomeMode === 'immediate' && canSpeakWelcome) {
          const assistantText = await voiceAgentSessions.ensureRunningAndMaybeWelcome(controlSessionId).catch(() => null);
          const text = typeof assistantText === 'string' ? assistantText.trim() : '';
          if (text) {
            projectLocalVoiceAgentAssistantText(controlSessionId, text);
            await speakAssistantText({
              sessionId,
              text,
              settings: params.settings,
              networkTimeoutMs,
              registerPlaybackStopper: playbackController.registerStopper,
              onSpeaking: () => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId }),
            });
          }
          return;
        }

        await voiceAgentSessions.ensureRunning(controlSessionId);
      })().catch((error) => {
        if (isUnsupportedVoiceAgentPrewarmError(error)) return;
        throw error;
      }),
      { tag: 'localVoiceEngine.prewarmLocalVoiceAgentOnConnect' },
    );
  };

  const prewarmDaemonVoiceInferenceOnConnect = (params: Readonly<{ settings: any }>): void => {
    if (VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.warmOnVoiceHomeAttach !== true) {
      return;
    }

    fireAndForget(
      warmDaemonVoiceInferenceOnVoiceHomeAttach({
        settings: params.settings,
        sessionId: controlSessionId,
      }),
    );
  };

  if (current.status === 'speaking') {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const provider = resolveLocalVoiceCaptureProvider(settings);
    const activeControlSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
    const bargeInDecision = localVoiceCaptureOwner.resolveManualBargeInAction({
      bargeInEnabled: isVoiceBargeInEnabled(settings),
      currentSessionId: current.sessionId,
      currentStatus: current.status,
      handsFree: isHandsFreeCaptureEnabled(settings, provider, config),
      provider,
      requestedSessionId: activeControlSessionId,
    });
    if (bargeInDecision.kind !== 'interrupt_and_rearm') {
      return;
    }

    playbackController.interrupt();
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    await ensureLocalConversationBindingForSession(settings, sessionId);
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    prewarmDaemonVoiceInferenceOnConnect({ settings });
    inFlight = startLocalVoiceCapture({
      sessionId: resolveLocalConversationControlSessionId(settings, bargeInDecision.sessionId),
      provider: bargeInDecision.provider,
      handsFree: bargeInDecision.handsFree,
      interrupted: true,
    }).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'idle') {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    await ensureLocalConversationBindingForSession(settings, sessionId);
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    prewarmDaemonVoiceInferenceOnConnect({ settings });
    const provider = resolveLocalVoiceCaptureProvider(settings);
    inFlight = startLocalVoiceCapture({
      sessionId: controlSessionId,
      provider,
      handsFree: isHandsFreeCaptureEnabled(settings, provider, config),
    }).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    const settings = storage.getState().settings as any;
    const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
    if (current.sessionId !== resolvedSessionId) {
      return;
    }

    const provider = resolveLocalVoiceCaptureProvider(settings);
    if (provider === 'device' || provider === 'local_neural') {
      localVoiceCaptureOwner.clearHandsFree({ provider, sessionId: resolvedSessionId });
    }

    inFlight = (provider === 'recorded_audio'
      ? stopAndSendRecordedTurn(resolvedSessionId)
      : stopSttAndSend(resolvedSessionId, provider)).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
}

export async function stopLocalVoiceSession(): Promise<void> {
  const current = getCurrentLocalRuntimeCompatState();
  if (!current.sessionId) return;

  const activeSessionId = current.sessionId;
  await settleEndingTransition(activeSessionId, 'disconnected', async () => {
    playbackController.interrupt();

    if (activeTurnAbortController && activeTurnAbortSessionId === activeSessionId) {
      try {
        activeTurnAbortController.abort();
      } catch {
        // ignore
      }
      activeTurnAbortController = null;
      activeTurnAbortSessionId = null;
    }

    await localVoiceCaptureOwner.stopSession(activeSessionId);
    voiceConversationRuntimeMachine.setMuted(false);

    if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
      try {
        await voiceAgentSessions.stop(activeSessionId);
      } catch {
        // ignore
      }
    }
  });
}
