import { fireAndForget } from '@/utils/system/fireAndForget';
import { createAttemptGuard } from '@/utils/timing/attemptGuard';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import {
  MissingBundledSpeechCredentialError,
  recordedAudioTranscriptionController,
  resolveRecordedAudioTranscriptionFailureReason,
} from '@/voice/runtime/input/recordedAudioTranscriptionController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { createVoiceBargeInController } from '@/voice/runtime/machine/voiceBargeInController';
import { turnTakingTelemetry } from '@/voice/input/turnTakingTelemetry';
import {
  deriveLocalVoiceRuntimeProjection,
  deriveLocalVoiceSessionSnapshot,
} from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  confirmVoiceCaptureStarted,
  surfaceRecoverableVoiceCaptureError,
  transitionVoiceRuntimeToIdle,
} from '@/voice/runtime/machine/voiceConversationRuntimeHelpers';
import { getVoiceConversationRuntimeSnapshot } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { isVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';
import {
  createLocalVoiceCaptureOwner,
  type LocalVoiceCaptureOwner,
  type LocalNeuralCaptureExecution,
  type LocalVoiceCaptureProvider,
} from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import {
  createRecordedAudioArtifactCleanup,
  deleteRecordedAudioArtifact,
  type RecordedAudioArtifactCleanup,
} from '@/voice/runtime/input/recordedAudioArtifactCleanup';
import {
  voiceCaptureAdmissionController,
  type VoiceCaptureAdmissionLease,
} from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { resolveVoiceSttCapturePlan } from '@/voice/runtime/input/resolveVoiceSttCapturePlan';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import type { TurnEndpointSignal } from '@/voice/runtime/input/TurnEndpointController';
import { createExpoAudioRecordingMicSession } from '@/voice/runtime/mic/NativeMicSession';
import {
  voiceRuntimeLevelStore,
  type VoiceRuntimeLevelWriter,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import { appendVoiceConversationAssistantText } from '@/voice/transcript/voiceConversationTranscript';
import { markVoiceConversationAssistantTurnInterrupted } from '@/voice/transcript/voiceTurnInterruption';
import { createTtsPlaybackClock } from '@/voice/output/ttsPlaybackTiming';
import { warmDaemonVoiceInferenceOnVoiceHomeAttach } from '@/voice/runtime/daemonInference/warmDaemonVoiceInferenceOnVoiceHomeAttach';
import { readDaemonVoiceInferenceClientErrorCode } from '@/voice/runtime/daemonInference/daemonVoiceInferenceErrors';
import { readSafeVoiceRuntimeFailureCode } from '@/voice/runtime/voiceRuntimeFailureCode';
import {
  isVoiceBargeInEnabled,
  isLocalVoiceProviderSelected,
  resolveAdaptiveInterruptionConfig,
  resolveLocalVoiceAdapterSettings,
  resolveLocalConversationControlSessionId,
} from './localVoiceSettings';
import { sendVoiceTextTurn as sendVoiceTextTurnImpl } from './sendVoiceTextTurn';
import {
  bindCurrentUiContextVoiceToolPortToAdmission,
  type VoiceCurrentUiToolPort,
} from '@/voice/tools/currentUiContextToolPort';
import {
  createCurrentUiContextAutomaticUpdateProjector,
  type CurrentUiContextAutomaticUpdateProjector,
  voiceHooks,
} from '@/voice/context/voiceHooks';

let inFlight: Promise<void> | null = null;
let activeTurnAbortController: AbortController | null = null;
let activeTurnAbortSessionId: string | null = null;
let inputLevelWriter: VoiceRuntimeLevelWriter | null = null;
type LocalVoiceCaptureAttempt = Readonly<{
  controlSessionId: string;
  lease: VoiceCaptureAdmissionLease;
  settings: Settings;
  provider: LocalVoiceCaptureProvider;
  handsFree: boolean;
  localNeuralExecution?: LocalNeuralCaptureExecution;
  executionMachineId: string | null;
}>;

type LocalVoiceCaptureAdmission = {
  controlSessionId: string;
  lease: VoiceCaptureAdmissionLease;
  captureAttempt: LocalVoiceCaptureAttempt;
  captureAbortController: AbortController;
  currentUiContext?: VoiceCurrentUiToolPort;
  currentUiContextRetirementController?: AbortController;
  currentUiContextAutomaticUpdateProjector?: CurrentUiContextAutomaticUpdateProjector;
  currentUiContextUnsubscribe?: () => void;
};

let captureAdmission: LocalVoiceCaptureAdmission | null = null;
const localVoicePreparationAttemptGuard = createAttemptGuard();

type EndpointDrivenCaptureProvider = Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>;

const playbackController = createVoicePlaybackController();
const localVoiceCaptureOwner = createLocalVoiceCaptureOwner({
  onCaptureStarted: (controlSessionId) => confirmVoiceCaptureStarted(controlSessionId),
  onCaptureError: (error) => {
    releaseCaptureAdmission(error.controlSessionId);
    surfaceRecoverableVoiceCaptureError(error);
  },
  getSettings: () => storage.getState().settings as any,
  onEndpointSignal: (signal) => {
    handleRuntimeOwnedEndpointSignal(signal);
  },
  onSpeechCandidateStart: ({ controlSessionId }) => {
    const admission = readCaptureAdmission(controlSessionId);
    if (!admission) return;
    bargeInController.onUserSpeechCandidate({
      sessionId: controlSessionId,
      bargeInEnabled: isVoiceBargeInEnabled(admission.captureAttempt.settings),
    });
  },
  onSpeechCandidateFalseAlarm: ({ controlSessionId }) => {
    bargeInController.cancelUserSpeechCandidate({ sessionId: controlSessionId });
  },
  // Continuous mic amplitude stays in the runtime-owned level store. The UI
  // bridges this channel to Reanimated without importing component code here.
  onLevel: (level) => {
    inputLevelWriter?.write(level);
  },
}, {
  createRecordingMicSession: createExpoAudioRecordingMicSession,
  createDeviceSttController,
  createSherpaSttController: createSherpaStreamingSttController,
});

function detachCaptureCurrentUiContext(controlSessionId?: string): void {
  const admission = captureAdmission;
  if (!admission) return;
  if (controlSessionId && admission.controlSessionId !== controlSessionId) return;
  if (!admission.currentUiContextRetirementController?.signal.aborted) {
    admission.currentUiContextRetirementController?.abort();
  }
  admission.currentUiContextUnsubscribe?.();
  admission.currentUiContextUnsubscribe = undefined;
}

function releaseCaptureAdmission(controlSessionId?: string): void {
  const admission = captureAdmission;
  if (!admission) return;
  if (controlSessionId && admission.controlSessionId !== controlSessionId) return;
  detachCaptureCurrentUiContext(controlSessionId);
  captureAdmission = null;
  admission.lease.release();
}

function abortCaptureAdmission(controlSessionId?: string): void {
  const admission = captureAdmission;
  if (!admission) return;
  if (controlSessionId && admission.controlSessionId !== controlSessionId) return;
  if (!admission.captureAbortController.signal.aborted) {
    admission.captureAbortController.abort();
  }
}

function resolveLocalVoiceCaptureAttempt(
  controlSessionId: string,
  lease: VoiceCaptureAdmissionLease,
): LocalVoiceCaptureAttempt {
  const state = storage.getState();
  const settings = settingsParse(state.settings);
  const capturePlan = resolveVoiceSttCapturePlan(settings);
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return Object.freeze({
    controlSessionId,
    lease,
    settings,
    provider: capturePlan.provider,
    handsFree: isHandsFreeCaptureEnabled(settings, capturePlan.provider, config),
    ...(capturePlan.localNeuralExecution
      ? { localNeuralExecution: capturePlan.localNeuralExecution }
      : {}),
    executionMachineId: resolveVoiceExecutionMachineIdFromState(state),
  });
}

function acquireCaptureAdmission(
  controlSessionId: string,
  currentUiContext?: VoiceCurrentUiToolPort,
): LocalVoiceCaptureAdmission | null {
  if (captureAdmission?.controlSessionId === controlSessionId) {
    captureAdmission.captureAttempt = resolveLocalVoiceCaptureAttempt(
      controlSessionId,
      captureAdmission.lease,
    );
    return captureAdmission;
  }
  if (captureAdmission) {
    surfaceRecoverableVoiceCaptureError({
      controlSessionId,
      reason: 'voice_capture_busy_conversation',
      kind: 'provider_error',
    });
    return null;
  }
  const admission = voiceCaptureAdmissionController.acquire('conversation');
  if (admission.status === 'busy') {
    surfaceRecoverableVoiceCaptureError({
      controlSessionId,
      reason: `voice_capture_busy_${admission.activeOwner}`,
      kind: 'provider_error',
    });
    return null;
  }
  const currentUiContextRetirementController = currentUiContext
    ? new AbortController()
    : undefined;
  captureAdmission = {
    controlSessionId,
    lease: admission.lease,
    captureAttempt: resolveLocalVoiceCaptureAttempt(controlSessionId, admission.lease),
    captureAbortController: new AbortController(),
    ...(currentUiContext && currentUiContextRetirementController ? {
      currentUiContext: bindCurrentUiContextVoiceToolPortToAdmission(
        currentUiContext,
        currentUiContextRetirementController.signal,
      ),
      currentUiContextRetirementController,
      currentUiContextAutomaticUpdateProjector: createCurrentUiContextAutomaticUpdateProjector(),
    } : {}),
  };
  return captureAdmission;
}

function readCaptureAdmission(controlSessionId: string): LocalVoiceCaptureAdmission | null {
  return captureAdmission?.controlSessionId === controlSessionId
    ? captureAdmission
    : null;
}

function isCaptureAdmissionCurrent(admission: LocalVoiceCaptureAdmission): boolean {
  return captureAdmission === admission;
}

function isCaptureAttemptCurrent(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
): boolean {
  return isCaptureAdmissionCurrent(admission)
    && admission.captureAttempt === captureAttempt
    && !admission.captureAbortController.signal.aborted;
}

function readCaptureCurrentUiContext(controlSessionId: string): VoiceCurrentUiToolPort | undefined {
  return captureAdmission?.controlSessionId === controlSessionId
    ? captureAdmission.currentUiContext
    : undefined;
}

function isCaptureCurrentUiContextAdmissionCurrent(admission: LocalVoiceCaptureAdmission): boolean {
  return captureAdmission === admission
    && admission.currentUiContextRetirementController?.signal.aborted !== true;
}

/**
 * The active capture admission owns this subscription. It starts only after
 * the local agent is live, and its callback must still name that exact
 * admission before publishing through the existing voice context channel.
 */
function beginAutomaticCurrentUiContextUpdates(controlSessionId: string): void {
  const admission = captureAdmission;
  const port = admission?.controlSessionId === controlSessionId
    ? admission.currentUiContext
    : undefined;
  const automaticUpdateProjector = admission?.controlSessionId === controlSessionId
    ? admission.currentUiContextAutomaticUpdateProjector
    : undefined;
  if (
    !admission
    || !port
    || !automaticUpdateProjector
    || admission.currentUiContextRetirementController?.signal.aborted === true
    || admission.currentUiContextUnsubscribe
  ) return;
  if (!voiceAgentSessions.isActive(controlSessionId)) return;

  const publishCurrentSnapshot = (): void => {
    if (!isCaptureCurrentUiContextAdmissionCurrent(admission)) return;
    const snapshot = port.readCurrentUiContext();
    voiceHooks.onCurrentUiContextChanged(controlSessionId, snapshot, automaticUpdateProjector);
  };
  const unsubscribe = port.subscribe(publishCurrentSnapshot);
  if (!isCaptureCurrentUiContextAdmissionCurrent(admission)) {
    unsubscribe();
    return;
  }
  admission.currentUiContextUnsubscribe = unsubscribe;
  publishCurrentSnapshot();
}

async function startCaptureWithInputLevel(
  args: Parameters<LocalVoiceCaptureOwner['startCapture']>[0],
): Promise<void> {
  inputLevelWriter?.close();
  const writer = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: args.sessionId });
  inputLevelWriter = writer;
  try {
    await localVoiceCaptureOwner.startCapture(args);
  } catch (error) {
    writer.close();
    if (inputLevelWriter === writer) inputLevelWriter = null;
    throw error;
  }
}

async function startCaptureForAdmission(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
  signal?: AbortSignal,
): Promise<void> {
  if (!isCaptureAdmissionCurrent(admission) || admission.captureAttempt !== captureAttempt) return;
  await startCaptureWithInputLevel({
    sessionId: captureAttempt.controlSessionId,
    provider: captureAttempt.provider,
    handsFree: captureAttempt.handsFree,
    ...(captureAttempt.localNeuralExecution
      ? { localNeuralExecution: captureAttempt.localNeuralExecution }
      : {}),
    settings: captureAttempt.settings,
    signal,
  });
}

function resetInputLevel(): void {
  inputLevelWriter?.reset();
}

function closeInputLevel(): void {
  const writer = inputLevelWriter;
  inputLevelWriter = null;
  writer?.close();
}

/**
 * Rearm leg for the automatic VAD-driven barge-in. The barge-in controller
 * drives the machine through `interruptAndRearmListening`, which calls this to
 * re-acquire the mic for the interrupting session. The admission refreshes at
 * this new capture boundary, then that snapshot owns its provider/settings
 * through stop and send.
 */
async function startBargeInRearmListening(sessionId: string, signal?: AbortSignal): Promise<void> {
  const admission = acquireCaptureAdmission(sessionId);
  if (!admission) return;
  await startCaptureForAdmission(admission, admission.captureAttempt, signal);
}

// Live automatic barge-in: the SINGLE owner of the "user spoke over the
// assistant" -> interruption decision for the local path. The playback
// controller owns provisional duck/retain, false-alarm restore, and confirmed
// destructive stop semantics.
const bargeInController = createVoiceBargeInController({
  machine: voiceConversationRuntimeMachine,
  playback: playbackController,
  onConfirmedInterruption: markPlaybackInterruptedForBargeIn,
  startListening: (signal) =>
    startBargeInRearmListening(voiceConversationRuntimeMachine.getSnapshot().controlSessionId ?? '', signal),
  telemetry: turnTakingTelemetry,
});

// Single owner of "how long has the assistant been speaking" for the local
// path. It is the source for BOTH the barge-in protected-head window
// (`resolveBargeInSpeakingElapsedMs`). It is
// "unknown" until the playback layer's `onSpeaking` drives `markStarted`, in
// which case elapsed reads as `MAX_SAFE_INTEGER` (treated as past any boundary).
const ttsPlaybackClock = createTtsPlaybackClock();
let activeAssistantPlaybackEntryId: string | null = null;

function noteAssistantFinalAvailable(assistantEntryId: string | null): void {
  const normalized = typeof assistantEntryId === 'string' ? assistantEntryId.trim() : '';
  activeAssistantPlaybackEntryId = normalized || null;
}

function noteTtsStarted(
  ttsText: string | null | undefined,
  assistantEntryId: string | null = null,
): void {
  noteAssistantFinalAvailable(assistantEntryId);
  ttsPlaybackClock.markStarted();
  bargeInController.onTtsStarted(ttsText);
}

function noteTtsStopped(): void {
  activeAssistantPlaybackEntryId = null;
  ttsPlaybackClock.reset();
  bargeInController.onTtsStopped();
}

function resolveBargeInSpeakingElapsedMs(detectedAt: number): number {
  // Unknown speaking start reads as MAX_SAFE_INTEGER so the protected head does
  // not suppress a genuine barge-in. The backchannel + echo gates still apply.
  return ttsPlaybackClock.playedMs(detectedAt);
}

/**
 * Resolve the conversation transcript session that owns the exact assistant
 * final currently bound to playback.
 */
function resolveActiveConversationSessionIdForInterruption(): string | null {
  const controlSessionId = voiceConversationRuntimeMachine.getSnapshot().controlSessionId;
  if (!controlSessionId) return null;
  const binding =
    voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId })
    ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: controlSessionId })
    ?? null;
  const conversationSessionId =
    typeof binding?.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
  return conversationSessionId || null;
}

/**
 * Mark the persisted assistant turn interrupted without guessing which text
 * prefix was heard. Automatic barge-in invokes this through the generic
 * controller's confirmed-interruption hook; manual barge-in composes it with
 * the playback controller below.
 */
function markPlaybackInterruptedForBargeIn(): void {
  const conversationSessionId = resolveActiveConversationSessionIdForInterruption();
  if (conversationSessionId) {
    markVoiceConversationAssistantTurnInterrupted({
      conversationSessionId,
      assistantEntryId: activeAssistantPlaybackEntryId,
    });
  }
}

function interruptPlaybackForBargeIn(): void {
  markPlaybackInterruptedForBargeIn();
  playbackController.interrupt();
}

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
  return resolveVoiceSttCapturePlan(settings).provider;
}

async function ensureLocalConversationBindingForSession(settings: any, sessionId: string): Promise<boolean> {
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  if (adapterId !== 'local_conversation' || (config?.conversationMode ?? 'direct_session') !== 'agent') {
    return true;
  }

  const controlSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  const requestedTargetSessionId =
    String(sessionId ?? '').trim() === VOICE_AGENT_GLOBAL_SESSION_ID ? null : String(sessionId ?? '').trim();
  const attempt = localVoicePreparationAttemptGuard.next();
  voiceConversationRuntimeMachine.transitionToConnecting({ controlSessionId });
  try {
    await voiceSessionBindingManager.ensureBound({
      adapterId: 'local_conversation',
      controlSessionId,
      requestedTargetSessionId,
    });
  } catch (error) {
    if (!localVoicePreparationAttemptGuard.isCurrent(attempt)) {
      return false;
    }
    const current = voiceConversationRuntimeMachine.getSnapshot();
    if (
      current.adapterId !== null
      || current.controlSessionId !== controlSessionId
      || current.state !== 'connecting'
    ) {
      return false;
    }
    surfaceRecoverableVoiceCaptureError({
      controlSessionId,
      reason: readSafeVoiceRuntimeFailureCode(error) ?? 'voice_connection_failed',
      kind: 'provider_error',
    });
    throw error;
  }

  if (!localVoicePreparationAttemptGuard.isCurrent(attempt)) {
    return false;
  }
  const current = voiceConversationRuntimeMachine.getSnapshot();
  return current.adapterId === null
    && current.controlSessionId === controlSessionId
    && current.state === 'connecting';
}

function isHandsFreeCaptureEnabled(settings: any, provider: LocalVoiceCaptureProvider, config: any): boolean {
  return provider !== 'recorded_audio' && config?.handsFree?.enabled === true;
}

function isEndpointDrivenCaptureProvider(provider: LocalVoiceCaptureProvider): provider is EndpointDrivenCaptureProvider {
  return provider === 'device' || provider === 'local_neural';
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

  const admission = acquireCaptureAdmission(followUp.sessionId);
  const captureAttempt = admission?.captureAttempt;
  if (
    !admission
    || !captureAttempt
    || !captureAttempt.handsFree
    || !isEndpointDrivenCaptureProvider(captureAttempt.provider)
  ) {
    return false;
  }

  await voiceConversationRuntimeMachine.rearmListening({
    controlSessionId: followUp.sessionId,
    startListening: (signal) => startCaptureForAdmission(admission, captureAttempt, signal),
  });
  return true;
}

function beginEndpointDrivenStopAndSend(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
  provider: EndpointDrivenCaptureProvider,
): void {
  if (inFlight) {
    return;
  }

  const operation = stopSttAndSend(admission, captureAttempt, provider).finally(() => {
    if (inFlight === operation) {
      inFlight = null;
    }
  });
  inFlight = operation;
}

function handleRuntimeOwnedEndpointSignal(signal: TurnEndpointSignal): void {
  const current = getCurrentLocalRuntimeCompatState();
  const admission = readCaptureAdmission(signal.sessionId);
  if (!admission) return;
  const captureAttempt = admission.captureAttempt;
  const { settings, provider } = captureAttempt;

  // Live barge-in: a runtime-owned endpoint that lands WHILE the assistant is
  // speaking is forwarded to the single barge-in owner instead of being dropped.
  // The controller re-validates machine state/session, the backchannel gate, and
  // the textual echo guard before it aborts playback + interrupt-and-rearms.
  if (current.status === 'speaking') {
    fireAndForget(
      bargeInController.handleUserSpeechDuringPlayback({
        sessionId: signal.sessionId,
        source: signal.source,
        transcript: signal.transcript,
        durationMs: signal.durationMs,
        confidence: signal.confidence,
        speakingElapsedMs: resolveBargeInSpeakingElapsedMs(signal.detectedAt),
        bargeInEnabled: isVoiceBargeInEnabled(settings),
      }),
      { tag: 'localVoiceEngine.bargeIn.handleUserSpeechDuringPlayback' },
    );
    return;
  }

  const endpointAction = localVoiceCaptureOwner.resolveEndpointSignalAction({
    currentSessionId: current.sessionId,
    currentStatus: current.status,
    handsFreeEnabled: captureAttempt.handsFree
      && isEndpointDrivenCaptureProvider(provider)
      && localVoiceCaptureOwner.isHandsFreeCaptureSession({ provider, sessionId: signal.sessionId }),
    inFlight: inFlight !== null,
    provider,
    signal,
  });
  if (endpointAction.kind !== 'stop_capture') {
    return;
  }

  beginEndpointDrivenStopAndSend(admission, captureAttempt, endpointAction.provider);
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
  interrupted?: boolean;
  currentUiContext?: VoiceCurrentUiToolPort;
}>): Promise<void> {
  const admission = acquireCaptureAdmission(args.sessionId, args.currentUiContext);
  if (!admission) {
    return;
  }
  const captureAttempt = admission.captureAttempt;

  let startError: unknown = null;
  const startListening = async (signal?: AbortSignal) => {
    try {
      await startCaptureForAdmission(admission, captureAttempt, signal);
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

  const startedState = getCurrentLocalRuntimeCompatState();
  if (
    !isCaptureAdmissionCurrent(admission)
    ||
    startedState.sessionId !== args.sessionId
    || startedState.status !== 'recording'
  ) {
    if (isCaptureAdmissionCurrent(admission)) {
      releaseCaptureAdmission(args.sessionId);
    }
  } else {
    beginAutomaticCurrentUiContextUpdates(args.sessionId);
  }

  if (captureAttempt.provider !== 'recorded_audio' || !startError) {
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
    beginAutomaticCurrentUiContextUpdates(sessionId);
  } catch (error) {
    if (isAbortedVoiceTurnError(error)) {
      return;
    }
    transitionVoiceRuntimeToIdle({
      controlSessionId: sessionId,
      reason: 'send_failed',
    });
    if (isVoiceTextTurnRejectedBeforeEffectError(error)) {
      throw error;
    }
    const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
    const shouldSwallowSendFailure = adapterId === 'local_conversation' && config?.conversationMode === 'agent';
    if (!shouldSwallowSendFailure) {
      throw error;
    }
    return;
  }
}

function surfaceRecordedAudioCleanupFailure(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
): void {
  if (!isCaptureAdmissionCurrent(admission) || admission.captureAttempt !== captureAttempt) return;
  const current = voiceConversationRuntimeMachine.getSnapshot();
  if (
    current.controlSessionId !== captureAttempt.controlSessionId
    || current.state === 'disconnected'
    || current.state === 'ending'
  ) {
    return;
  }
  transitionVoiceRuntimeToIdle({
    controlSessionId: captureAttempt.controlSessionId,
    reason: 'recording_cleanup_failed',
    kind: 'provider_error',
  });
}

async function stopAndSendRecordedTurn(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
): Promise<void> {
  const sessionId = captureAttempt.controlSessionId;
  if (
    !isCaptureAttemptCurrent(admission, captureAttempt)
    || captureAttempt.provider !== 'recorded_audio'
  ) {
    return;
  }
  voiceConversationRuntimeMachine.transitionToTranscribing({ controlSessionId: sessionId });
  let uri: string | null = null;
  let artifactCleanup: RecordedAudioArtifactCleanup | null = null;
  try {
    try {
      const stopped = await localVoiceCaptureOwner.stopCapture({
        sessionId,
        provider: captureAttempt.provider,
      });
      resetInputLevel();
      uri = stopped.provider === 'recorded_audio' ? stopped.uri : null;
      if (uri) {
        artifactCleanup = createRecordedAudioArtifactCleanup(deleteRecordedAudioArtifact);
        artifactCleanup.admit(uri);
      }
    } catch {
      transitionVoiceRuntimeToIdle({
        controlSessionId: sessionId,
        reason: 'recording_stop_failed',
      });
      return;
    }

    if (!uri) {
      if (!isCaptureAttemptCurrent(admission, captureAttempt)) return;
      transitionVoiceRuntimeToIdle({
        controlSessionId: sessionId,
        reason: 'recording_uri_missing',
      });
      return;
    }

    if (!isCaptureAttemptCurrent(admission, captureAttempt)) return;

    let text: string | null = null;
    try {
      text = await recordedAudioTranscriptionController.transcribe({
        sessionId,
        uri,
        executionMachineId: captureAttempt.executionMachineId,
        settings: captureAttempt.settings,
        signal: admission.captureAbortController.signal,
      });
    } catch (error) {
      if (!isCaptureAttemptCurrent(admission, captureAttempt)) return;
      if (error instanceof MissingBundledSpeechCredentialError) {
        transitionVoiceRuntimeToIdle({
          controlSessionId: sessionId,
          reason: 'missing_stt_api_key',
        });
        throw error;
      }
      transitionVoiceRuntimeToIdle({
        controlSessionId: sessionId,
        reason: resolveRecordedAudioTranscriptionFailureReason(error),
      });
      return;
    }

    if (!isCaptureAttemptCurrent(admission, captureAttempt)) return;
    if (!text) {
      transitionVoiceRuntimeToIdle({ controlSessionId: sessionId });
      return;
    }

    const currentUiContext = admission.currentUiContext;
    await runVoiceTurnWithSendFailureHandling(sessionId, captureAttempt.settings, (signal) =>
      sendVoiceTextTurnImpl({
        sessionId,
        settings: captureAttempt.settings,
        userText: text,
        playbackController,
        voiceAgentSessions,
        onTtsStarted: noteTtsStarted,
        onAssistantFinalAvailable: noteAssistantFinalAvailable,
        onTtsStopped: noteTtsStopped,
        signal,
        ...(currentUiContext ? { currentUiContext } : {}),
      }),
    );
  } finally {
    const cleanupResult = await artifactCleanup?.cleanup();
    if (cleanupResult?.kind === 'failed') {
      surfaceRecordedAudioCleanupFailure(admission, captureAttempt);
    }
  }
}

async function stopSttAndSend(
  admission: LocalVoiceCaptureAdmission,
  captureAttempt: LocalVoiceCaptureAttempt,
  provider: Extract<LocalVoiceCaptureProvider, 'device' | 'local_neural'>,
): Promise<void> {
  const sessionId = captureAttempt.controlSessionId;
  if (
    !isCaptureAdmissionCurrent(admission)
    || admission.captureAttempt !== captureAttempt
    || captureAttempt.provider !== provider
  ) {
    transitionVoiceRuntimeToIdle({
      controlSessionId: sessionId,
      reason: 'recording_stop_failed',
    });
    return;
  }
  voiceConversationRuntimeMachine.transitionToTranscribing({ controlSessionId: sessionId });

  const endpointDecision = await localVoiceCaptureOwner.stopEndpointDrivenCapture({
    adaptiveConfig: resolveAdaptiveInterruptionConfig(),
    provider,
    sessionId,
  });
  resetInputLevel();

  if (endpointDecision.kind === 'ignore') {
    if (voiceConversationRuntimeMachine.getSnapshot().error) {
      return;
    }
    if (await maybeRearmHandsFreeCapture(endpointDecision.followUp)) {
      return;
    }
    transitionVoiceRuntimeToIdle({ controlSessionId: sessionId });
    return;
  }

  await runVoiceTurnWithSendFailureHandling(sessionId, captureAttempt.settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings: captureAttempt.settings,
      userText: endpointDecision.transcript,
      playbackController,
      voiceAgentSessions,
      onTtsStarted: noteTtsStarted,
      onAssistantFinalAvailable: noteAssistantFinalAvailable,
      onTtsStopped: noteTtsStopped,
      signal,
      ...(admission.currentUiContext ? { currentUiContext: admission.currentUiContext } : {}),
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

export function appendLocalVoiceAgentAutomaticUiContextUpdate(sessionId: string, update: string): void {
  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  voiceAgentSessions.appendAutomaticUiContextUpdate(resolvedSessionId, update);
}

function projectLocalVoiceAgentAssistantText(sessionId: string, text: string): string | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const binding =
    voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: sessionId })
    ?? voiceConversationBindingResolver.resolveByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const conversationSessionId = typeof binding?.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
  if (!conversationSessionId) return null;

  return appendVoiceConversationAssistantText({
    conversationSessionId,
    text: trimmed,
  });
}

export function announceLocalVoiceAgentAssistantText(sessionId: string, text: string): void {
  projectLocalVoiceAgentAssistantText(sessionId, text);
}

export async function sendLocalVoiceAgentTextTurn(
  sessionId: string,
  text: string,
  durableDispatch?: Readonly<{
    localId: string;
    deliveryCommand: 'interrupt_and_send';
  }>,
  onAccepted?: () => Promise<void>,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  const currentUiContext = readCaptureCurrentUiContext(resolvedSessionId);
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId: resolvedSessionId,
      settings,
      userText: trimmed,
      playbackController,
      voiceAgentSessions,
      onTtsStarted: noteTtsStarted,
      onAssistantFinalAvailable: noteAssistantFinalAvailable,
      onTtsStopped: noteTtsStopped,
      signal,
      durableDispatch,
      onUserTranscriptAccepted: onAccepted,
      ...(currentUiContext ? { currentUiContext } : {}),
    }),
  );
}

export async function sendLocalVoiceAgentTextUpdate(sessionId: string, update: string): Promise<void> {
  const text = update.trim();
  if (!text) return;

  const settings = storage.getState().settings as any;
  const resolvedSessionId = resolveLocalConversationControlSessionId(settings, sessionId);
  const currentUiContext = readCaptureCurrentUiContext(resolvedSessionId);
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
      onTtsStarted: noteTtsStarted,
      onAssistantFinalAvailable: noteAssistantFinalAvailable,
      onTtsStopped: noteTtsStopped,
      signal,
      ...(currentUiContext ? { currentUiContext } : {}),
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
      const currentSnapshot = voiceConversationRuntimeMachine.getSnapshot();
      voiceConversationRuntimeMachine.transitionToDisconnected({
        controlSessionId,
        error: currentSnapshot.controlSessionId === controlSessionId ? currentSnapshot.error : null,
      });
    } else {
      // Settle to the idle, mic-off `connected` state between turns.
      voiceConversationRuntimeMachine.transitionToConnected({ controlSessionId });
    }
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
    noteTtsStopped();
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
  if (muted) resetInputLevel();
  voiceConversationRuntimeMachine.setMuted({
    controlSessionId: resolvedSessionId,
    adapterId: null,
    attemptId: null,
    micMuted: muted,
  });
}

export async function toggleLocalVoiceTurn(
  sessionId: string,
  currentUiContext?: VoiceCurrentUiToolPort,
): Promise<void> {
  const initialSettings = storage.getState().settings as any;
  if (!isLocalVoiceProviderSelected(initialSettings)) {
    return;
  }
  const controlSessionId = resolveLocalConversationControlSessionId(initialSettings, sessionId);

  // The runtime machine is the single lifecycle source; derive the realtime
  // session snapshot from it (the transport no longer keeps a private snapshot).
  // The machine slot is shared, so only treat it as a live realtime call when
  // the realtime adapter actually owns it — a local session (ownerless slot)
  // projects `disconnected` for the realtime adapter id and must not block here.
  const machineSnapshot = getVoiceConversationRuntimeSnapshot();
  const machineOwnerId = machineSnapshot.adapterId;
  const machineOwner = machineOwnerId
    ? getVoiceAdapterRegistry().get(machineOwnerId)
    : null;
  // A non-null machine owner is non-local by contract. Consult its semantic
  // registration when present; unknown owners fail closed as realtime so a
  // newly added/temporarily unavailable adapter cannot overlap the mic.
  const ownerEngineKind = machineOwner?.engineKind ?? (machineOwnerId ? 'realtime' : null);
  const realtimeSessionSnapshot = machineOwnerId && ownerEngineKind === 'realtime'
    ? deriveLocalVoiceSessionSnapshot(machineOwnerId, ownerEngineKind, machineSnapshot)
    : null;
  if (
    realtimeSessionSnapshot
    && (realtimeSessionSnapshot.status === 'connected' || realtimeSessionSnapshot.status === 'connecting')
  ) {
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
        const registerPlaybackStopper =
          playbackController.registerStopper.captureAttempt?.() ?? playbackController.registerStopper;
        const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
        const welcome = voiceSettingsParse(params.settings?.voice).welcome;
        const welcomeMode = welcome.mode;
        const welcomeEnabled = welcome.enabled;
        const canSpeakWelcome = config?.tts?.autoSpeakReplies !== false;

        if (welcomeEnabled && welcomeMode === 'immediate' && canSpeakWelcome) {
          const assistantText = await voiceAgentSessions.ensureRunningAndMaybeWelcome(controlSessionId).catch(() => null);
          beginAutomaticCurrentUiContextUpdates(controlSessionId);
          const text = typeof assistantText === 'string' ? assistantText.trim() : '';
          if (text) {
            const assistantEntryId = projectLocalVoiceAgentAssistantText(controlSessionId, text);
            await speakAssistantText({
              sessionId,
              text,
              settings: params.settings,
              networkTimeoutMs,
              registerPlaybackStopper,
              onSpeaking: () => {
                noteTtsStarted(text, assistantEntryId);
                voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId });
              },
            });
            noteTtsStopped();
          }
          return;
        }

        await voiceAgentSessions.ensureRunning(controlSessionId);
        beginAutomaticCurrentUiContextUpdates(controlSessionId);
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
      {
        tag: 'localVoiceEngine.prewarmDaemonVoiceInferenceOnConnect',
        onError: (error) => {
          const current = voiceConversationRuntimeMachine.getSnapshot();
          if (
            current.controlSessionId !== controlSessionId
            || current.state === 'disconnected'
            || current.state === 'ending'
            || current.state === 'error'
            || current.state === 'mic_error'
          ) {
            return;
          }
          surfaceRecoverableVoiceCaptureError({
            controlSessionId,
            reason: `daemon_voice_inference_${readDaemonVoiceInferenceClientErrorCode(error)}`,
          });
        },
      },
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

    interruptPlaybackForBargeIn();
    noteTtsStopped();
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    if (!await ensureLocalConversationBindingForSession(settings, sessionId)) {
      return;
    }
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    prewarmDaemonVoiceInferenceOnConnect({ settings });
    inFlight = startLocalVoiceCapture({
      sessionId: resolveLocalConversationControlSessionId(settings, bargeInDecision.sessionId),
      interrupted: true,
      ...(currentUiContext ? { currentUiContext } : {}),
    }).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'idle') {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    if (!await ensureLocalConversationBindingForSession(settings, sessionId)) {
      return;
    }
    prewarmLocalVoiceAgentOnConnect({ settings, config });
    prewarmDaemonVoiceInferenceOnConnect({ settings });
    inFlight = startLocalVoiceCapture({
      sessionId: controlSessionId,
      ...(currentUiContext ? { currentUiContext } : {}),
    }).finally(() => {
      inFlight = null;
    });
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    const resolvedSessionId = current.sessionId;
    if (!resolvedSessionId) return;
    const admission = readCaptureAdmission(resolvedSessionId);
    if (!admission) return;

    const captureAttempt = admission.captureAttempt;
    const provider = captureAttempt.provider;
    if (provider === 'device' || provider === 'local_neural') {
      localVoiceCaptureOwner.clearHandsFree({ provider, sessionId: resolvedSessionId });
    }

    inFlight = (provider === 'recorded_audio'
      ? stopAndSendRecordedTurn(admission, captureAttempt)
      : stopSttAndSend(admission, captureAttempt, provider)).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }
}

export async function stopLocalVoiceSession(): Promise<void> {
  // A Voice Home carrier may still be resolving before capture starts. Fence
  // that work before reading the machine so a late completion cannot revive
  // the microphone after Stop (including a same-session retry).
  localVoicePreparationAttemptGuard.cancel();
  const current = getCurrentLocalRuntimeCompatState();
  if (!current.sessionId) {
    releaseCaptureAdmission();
    return;
  }

  const activeSessionId = current.sessionId;
  // The UI-context subscription carries the admitting Account's authority.
  // Revoke it synchronously; native capture cleanup may yield while the next
  // Account is already publishing through the shared current-UI port.
  detachCaptureCurrentUiContext(activeSessionId);
  // Recorded STT is an attempt-local asynchronous boundary. Cancel it before
  // any teardown can yield, and retain the same admission as its currentness
  // owner until capture cleanup releases the lease.
  abortCaptureAdmission(activeSessionId);
  await settleEndingTransition(activeSessionId, 'disconnected', async () => {
    playbackController.interrupt();
    noteTtsStopped();
    let captureCleanupError: unknown = null;

    if (activeTurnAbortController && activeTurnAbortSessionId === activeSessionId) {
      try {
        activeTurnAbortController.abort();
      } catch {
        // ignore
      }
      activeTurnAbortController = null;
      activeTurnAbortSessionId = null;
    }

    try {
      await localVoiceCaptureOwner.stopSession(activeSessionId);
    } catch (error) {
      // Capture cleanup reports its own error fact. End Voice must still
      // complete the independent input and Local Agent teardown below before
      // the original cleanup failure reaches the caller.
      captureCleanupError = error;
    }
    voiceConversationRuntimeMachine.setMuted({
      controlSessionId: activeSessionId,
      adapterId: null,
      attemptId: null,
      micMuted: false,
    });
    // Invalidate the attempt-bound input writer so late mic frames cannot
    // revive the visual after teardown.
    closeInputLevel();

    if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
      try {
        await voiceAgentSessions.stop(activeSessionId);
      } catch {
        // ignore
      }
    }
    // Release only after capture/session cleanup, but before the runtime
    // publishes disconnected and a configured provider switch may start its
    // replacement capture path synchronously.
    releaseCaptureAdmission(activeSessionId);
    if (captureCleanupError) {
      throw captureCleanupError;
    }
  }).finally(() => {
    releaseCaptureAdmission(activeSessionId);
  });
}
