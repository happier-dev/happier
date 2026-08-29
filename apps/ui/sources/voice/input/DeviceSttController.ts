import {
  isPermissionDeniedMicrophoneError,
  requestMicrophonePermission,
  showMicrophonePermissionDeniedAlert,
} from '@/utils/platform/microphonePermissions';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/voice/adapters/local/settings';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { normalizeTurnEndpointPolicy } from '@/voice/runtime/input/TurnEndpointDetector';
import {
  createTurnEndpointController, type TurnEndpointController, type TurnEndpointSignal, } from '@/voice/runtime/input/TurnEndpointController';
import {
  createWebVadController, type WebVadController, } from '@/voice/runtime/input/WebVadController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { Platform } from 'react-native';
import {
  getSharedVoiceAudioSessionCoordinator,
  type VoiceAudioSessionCoordinator,
  type VoiceAudioSessionLease,
} from '@happier-dev/audio-stream-native';

import type { SttController, SttStartParams, SttStopResult } from './sttController';
import { readDeviceSpeechRecognitionAvailability } from './deviceSpeechRecognitionAvailability';

type DeviceSttHandle = {
  sessionId: string;
  latestInterimText: string;
  finalSegments: string[];
  terminalResult: SttStopResult | null;
  module: any;
  resolveEnd: () => void;
  endPromise: Promise<void>;
  subscriptions: { remove(): void }[];
  audioStarted: boolean;
  acceptsRecognizerEvents: boolean;
  /** Detaches the D8 abort listener; idempotent and safe after teardown. */
  abortCleanup: () => void;
  recognizerStopRequested: boolean;
  audioSessionLease: VoiceAudioSessionLease | null;
  audioSessionReleaseAttempt: Promise<void> | null;
  speechCandidateActive: boolean;
  cleanupAttempt: Promise<void> | null;
};

type DeviceSttStartReservation = {
  cancelled: boolean;
  cancellation: Promise<void>;
  cancel: () => void;
  settled: Promise<void>;
  resolveSettled: () => void;
};

export type DeviceSttController = SttController;

export type CreateDeviceSttControllerDeps = {
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  onSpeechCandidateStart?: (input: Readonly<{ sessionId: string; source: 'device_recognizer' }>) => void;
  onSpeechCandidateFalseAlarm?: (input: Readonly<{ sessionId: string; source: 'device_recognizer' }>) => void;
  endpointController?: TurnEndpointController;
  webVadController?: WebVadController;
  getAudioSessionCoordinator?: () => VoiceAudioSessionCoordinator | null;
  /** Stop wait before forcing finalize; defaults to the recognizer end timeout. */
  stopTimeoutMs?: number;
};

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function safelyNotifyObserver(notify: () => void): void {
  try {
    notify();
  } catch {
    // Observers cannot take ownership of provider state or resource cleanup.
  }
}

function isEmptyRecognitionTerminalReason(reason: string): boolean {
  return reason === 'no-speech' || reason === 'speech-timeout';
}

/**
 * Resolve whether to request continuous recognition for this platform/turn.
 *
 * - Web / any DOM runtime: false — Web Speech is single-utterance; turn
 *   continuity is driven by the long-lived {@link WebMicSession} stream + WebVAD
 *   endpointing rather than recognizer-level continuity.
 * - Android < 13 (API 33): false — `SpeechRecognizer` has no reliable continuous
 *   mode; the recognizer auto-stops and hands-free rearm restarts it.
 * - iOS / Android >= 13: true — iOS non-continuous recognition auto-stops after
 *   ~3s of silence, so continuous is requested to let a hands-free turn outlive
 *   natural pauses.
 */
function resolveDeviceContinuousRecognition(args: Readonly<{
  platformOs: string;
  isDomRuntime: boolean;
}>): boolean {
  if (args.isDomRuntime || args.platformOs === 'web') {
    return false;
  }
  if (args.platformOs === 'android') {
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
    if (!Number.isFinite(apiLevel) || apiLevel < 33) {
      return false;
    }
  }
  return true;
}

export function createDeviceSttController(deps: CreateDeviceSttControllerDeps): DeviceSttController {
  let handle: DeviceSttHandle | null = null;
  let startReservation: DeviceSttStartReservation | null = null;
  let completedResult: SttStopResult | null = null;

  const isDomRuntime = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';
  const normalizeSessionId = (sessionId: string | null | undefined): string | null => normalizeNonEmptyString(sessionId);
  const stopTimeoutMs = typeof deps.stopTimeoutMs === 'number' && deps.stopTimeoutMs >= 0
    ? deps.stopTimeoutMs
    : DEFAULT_STOP_TIMEOUT_MS;

  const resolveAdapterSettings = () => {
    return resolveLocalVoiceAdapterSettings(deps.getSettings()).config;
  };

  const endpointController = deps.endpointController ?? createTurnEndpointController({
    onSignal: (signal) => {
      safelyNotifyObserver(() => deps.onEndpointSignal?.(signal));
    },
  });
  const webVadController = deps.webVadController ?? createWebVadController({
    onEndpointSignal: (signal) => {
      safelyNotifyObserver(() => deps.onEndpointSignal?.(signal));
    },
  });

  const resolveHandsFreeTurnEndpointPolicy = () => {
    const adapter = resolveAdapterSettings();
    return normalizeTurnEndpointPolicy({
      silenceMs: adapter?.handsFree?.endpointing?.silenceMs ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
      minSpeechMs: adapter?.handsFree?.endpointing?.minSpeechMs ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
    });
  };

  const releaseAudioSessionLease = async (target: DeviceSttHandle): Promise<void> => {
    if (!target.audioSessionLease) return;
    if (target.audioSessionReleaseAttempt) return await target.audioSessionReleaseAttempt;
    const lease = target.audioSessionLease;
    const attempt = lease.release();
    target.audioSessionReleaseAttempt = attempt;
    if (target.audioSessionLease === lease) target.audioSessionLease = null;
    try {
      await attempt;
    } finally {
      if (target.audioSessionReleaseAttempt === attempt) target.audioSessionReleaseAttempt = null;
    }
  };

  const cleanupCaptureOwners = async (target: DeviceSttHandle): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await webVadController.stopSession(target.sessionId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await releaseAudioSessionLease(target);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Device STT capture-owner cleanup failed.');
  };

  const cleanupHandle = async (target: DeviceSttHandle): Promise<void> => {
    if (target.cleanupAttempt) return await target.cleanupAttempt;
    const attempt = (async () => {
      target.acceptsRecognizerEvents = false;
      endpointController.clearSession(target.sessionId);
      target.abortCleanup();
      try {
        target.subscriptions.forEach((subscription) => subscription.remove());
      } catch {
        // ignore
      }
      await cleanupCaptureOwners(target);
      if (target.terminalResult) completedResult = target.terminalResult;
      if (handle === target) handle = null;
    })();
    target.cleanupAttempt = attempt;
    try {
      await attempt;
    } catch (error) {
      if (target.cleanupAttempt === attempt) target.cleanupAttempt = null;
      throw error;
    }
  };

  const start = async ({ micSession, sink, signal }: SttStartParams) => {
    if (signal?.aborted) {
      completedResult = {
        error: createVoiceMachineError({ kind: 'turn_aborted', reason: 'turn_aborted' }),
      };
      return;
    }
    if (handle || startReservation) {
      throw new Error('device_stt_already_started');
    }
    let resolveReservation!: () => void;
    let resolveCancellation!: () => void;
    const reservation: DeviceSttStartReservation = {
      cancelled: false,
      cancellation: new Promise<void>((resolve) => { resolveCancellation = resolve; }),
      cancel: () => {
        if (reservation.cancelled) return;
        reservation.cancelled = true;
        resolveCancellation();
      },
      settled: new Promise<void>((resolve) => { resolveReservation = resolve; }),
      resolveSettled: () => resolveReservation(),
    };
    startReservation = reservation;
    const onSetupAbort = () => {
      reservation.cancel();
    };
    signal?.addEventListener('abort', onSetupAbort, { once: true });
    let permissionDeniedAlertPresented = false;
    const presentPermissionDenied = (canAskAgain = false): void => {
      if (permissionDeniedAlertPresented) return;
      permissionDeniedAlertPresented = true;
      showMicrophonePermissionDeniedAlert(canAskAgain);
    };

    const recordSetupCancellation = () => {
      if (!signal?.aborted) return;
      completedResult = {
        error: createVoiceMachineError({ kind: 'turn_aborted', reason: 'turn_aborted' }),
      };
    };

    const runSetupStage = async <T,>(
      startStage: () => Promise<T>,
      cleanupLateValue?: (value: T) => void | Promise<void>,
    ): Promise<Readonly<{ cancelled: true }> | Readonly<{ cancelled: false; value: T }>> => {
      if (signal?.aborted || reservation.cancelled) {
        return { cancelled: true };
      }

      const operation = startStage();
      const operationOutcome = operation.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      const outcome = await Promise.race([
        operationOutcome,
        reservation.cancellation.then(() => ({ kind: 'cancelled' as const })),
      ]);

      if (outcome.kind === 'cancelled') {
        void operationOutcome.then(async (lateOutcome) => {
          if (lateOutcome.kind === 'resolved' && cleanupLateValue) {
            await cleanupLateValue(lateOutcome.value);
          }
        }).catch(() => {});
        return { cancelled: true };
      }
      if (outcome.kind === 'rejected') {
        throw outcome.error;
      }
      if (signal?.aborted || reservation.cancelled) {
        if (cleanupLateValue) {
          const cleanup = Promise.resolve(cleanupLateValue(outcome.value));
          void cleanup.catch(() => {});
        }
        return { cancelled: true };
      }
      return { cancelled: false, value: outcome.value };
    };

    try {
    if (!micSession) {
      throw new Error('mic_session_required');
    }

    const recognitionModuleStage = await runSetupStage(() => import('expo-speech-recognition'));
    if (recognitionModuleStage.cancelled) {
      recordSetupCancellation();
      return;
    }
    const { ExpoSpeechRecognitionModule } = recognitionModuleStage.value;

    if (readDeviceSpeechRecognitionAvailability(ExpoSpeechRecognitionModule) !== 'available') {
      const unavailableError = createVoiceMachineError({
        kind: 'provider_error',
        reason: 'device_stt_unavailable',
      });
      completedResult = { error: unavailableError };
      safelyNotifyObserver(() => sink.onError(unavailableError));
      return;
    }

    const microphonePermissionStage = await runSetupStage(requestMicrophonePermission);
    if (microphonePermissionStage.cancelled) {
      recordSetupCancellation();
      return;
    }
    const microphonePermission = microphonePermissionStage.value;
    if (!microphonePermission.granted) {
      presentPermissionDenied(microphonePermission.canAskAgain);
      throw new Error('mic_permission_denied');
    }

    // `expo-speech-recognition` logs noisy "not supported on web" warnings for this call.
    // Prefer DOM detection over Platform.OS so web builds remain resilient even if Platform.OS is surprising.
    if (Platform.OS !== 'web' && !isDomRuntime()) {
      try {
        const permissionsStage = await runSetupStage(async () => {
          return await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        });
        if (permissionsStage.cancelled) {
          recordSetupCancellation();
          return;
        }
        const permissionsResponse = permissionsStage.value;
        if (permissionsResponse && permissionsResponse.granted === false) {
          presentPermissionDenied(permissionsResponse.canAskAgain === true);
          throw new Error('mic_permission_denied');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'mic_permission_denied') {
          presentPermissionDenied(false);
          throw error;
        }
        if (isPermissionDeniedMicrophoneError(error)) {
          presentPermissionDenied(false);
          throw new Error('mic_permission_denied');
        }
        // Permission request best-effort otherwise.
      }
    }

    endpointController.clearSession();
    const previousVadStopStage = await runSetupStage(() => webVadController.stopSession());
    if (previousVadStopStage.cancelled) {
      recordSetupCancellation();
      return;
    }

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    // Capture a stable session key for guards; the runtime owner correlates the
    // active capture, so the controller keys its own handle off a synthetic id.
    const sessionKey = normalizeSessionId(`device-${Date.now()}-${Math.random()}`) ?? 'device-capture';
    const platformOs = Platform.OS;
    const dom = isDomRuntime();
    const usesProviderManagedNativeCapture = platformOs !== 'web' && !dom;
    let audioSessionLease: VoiceAudioSessionLease | null = null;
    if (usesProviderManagedNativeCapture) {
      const coordinator = (deps.getAudioSessionCoordinator ?? getSharedVoiceAudioSessionCoordinator)();
      if (!coordinator) {
        const audioSessionUnavailableError = createVoiceMachineError({
          kind: 'provider_error',
          reason: 'device_stt_audio_session_unavailable',
        });
        safelyNotifyObserver(() => sink.onError(audioSessionUnavailableError));
        throw new Error('device_stt_audio_session_unavailable');
      }
      try {
        const audioSessionStage = await runSetupStage(
          () => coordinator.acquire({
            ownerId: `device-stt:${sessionKey}`,
            mode: 'dictation',
            input: true,
            output: false,
            aec: 'off',
            capture: 'provider_managed_exclusive',
          }),
          (lateLease) => lateLease.release(),
        );
        if (audioSessionStage.cancelled) {
          recordSetupCancellation();
          return;
        }
        audioSessionLease = audioSessionStage.value;
      } catch (error) {
        const audioSessionAcquireError = createVoiceMachineError({
          kind: 'provider_error',
          reason: 'device_stt_audio_session_acquire_failed',
        });
        safelyNotifyObserver(() => sink.onError(audioSessionAcquireError));
        throw error;
      }
    } else {
      // Browser WebVAD and Web Speech share the browser-owned mic session.
      const micStage = await runSetupStage(() => micSession.ensureActive());
      if (micStage.cancelled) {
        recordSetupCancellation();
        return;
      }
    }

    const nextHandle: DeviceSttHandle = {
      sessionId: sessionKey,
      latestInterimText: '',
      finalSegments: [],
      terminalResult: null,
      module: ExpoSpeechRecognitionModule,
      resolveEnd: () => resolveEnd?.(),
      endPromise,
      subscriptions: [],
      audioStarted: false,
      acceptsRecognizerEvents: true,
      abortCleanup: () => {},
      recognizerStopRequested: false,
      audioSessionLease,
      audioSessionReleaseAttempt: null,
      speechCandidateActive: false,
      cleanupAttempt: null,
    };

    try {
      endpointController.startSession(sessionKey);
      const handsFreeTurnEndpointPolicy = resolveHandsFreeTurnEndpointPolicy();
      let useHeuristicFinalEndpoint = platformOs !== 'web';
      if (platformOs === 'web') {
        const vadStage = await runSetupStage(
          () => webVadController.startSession({
            sessionId: sessionKey,
            minSpeechMs: handsFreeTurnEndpointPolicy.minSpeechMs,
            redemptionMs: handsFreeTurnEndpointPolicy.silenceMs,
            // Drive WebVAD off the canonical capture stream + shared AudioContext so
            // web hands-free runs on one mic acquisition instead of a self-opened one.
            micSession,
          }),
          () => webVadController.stopSession(sessionKey),
        );
        if (vadStage.cancelled) {
          endpointController.clearSession(sessionKey);
          void webVadController.stopSession(sessionKey).catch(() => {});
          nextHandle.resolveEnd();
          recordSetupCancellation();
          return;
        }
        useHeuristicFinalEndpoint = !vadStage.value;
      }
      handle = nextHandle;

    const markAudioStarted = () => {
      if (!nextHandle.acceptsRecognizerEvents || handle !== nextHandle || nextHandle.audioStarted) {
        return;
      }
      nextHandle.audioStarted = true;
      safelyNotifyObserver(() => sink.onAudioStarted());
    };

    const stopRecognizerOnce = () => {
      if (nextHandle.recognizerStopRequested) {
        return;
      }
      nextHandle.recognizerStopRequested = true;
      try {
        nextHandle.module?.stop?.();
      } catch {
        // ignore
      }
    };

    const markSpeechCandidateStarted = () => {
      if (nextHandle.speechCandidateActive) return;
      nextHandle.speechCandidateActive = true;
      safelyNotifyObserver(() => deps.onSpeechCandidateStart?.({
        sessionId: sessionKey,
        source: 'device_recognizer',
      }));
    };

    const resolveSpeechCandidateFalseAlarm = () => {
      if (!nextHandle.speechCandidateActive) return;
      nextHandle.speechCandidateActive = false;
      safelyNotifyObserver(() => deps.onSpeechCandidateFalseAlarm?.({
        sessionId: sessionKey,
        source: 'device_recognizer',
      }));
    };

    const committedTranscript = (): string => nextHandle.finalSegments.join(' ').trim();

    const resolveTerminalResult = (): SttStopResult => {
      const finalText = committedTranscript();
      if (finalText) return { finalText };
      if (nextHandle.latestInterimText) {
        return {
          error: createVoiceMachineError({
            kind: 'provider_error',
            reason: 'device_stt_finalization_failed',
          }),
        };
      }
      if (!nextHandle.recognizerStopRequested) {
        return {
          error: createVoiceMachineError({
            kind: 'provider_error',
            reason: 'device_stt_error',
          }),
        };
      }
      return { finalText: '' };
    };

    const acceptsRecognizerEvent = (): boolean => {
      return nextHandle.acceptsRecognizerEvents && handle === nextHandle;
    };

    const finalizeTranscriptEndpoint = (transcript: string) => {
      safelyNotifyObserver(() => sink.onFinal(transcript));
      if (!useHeuristicFinalEndpoint) return;
      safelyNotifyObserver(() => sink.onEndpoint('silence'));
      safelyNotifyObserver(() => endpointController.signalHeuristicTranscriptFinalized({
        sessionId: sessionKey,
        transcript,
        policy: handsFreeTurnEndpointPolicy,
      }));
    };

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('audiostart', () => {
        if (!acceptsRecognizerEvent()) return;
        markAudioStarted();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('speechstart', () => {
        if (!acceptsRecognizerEvent()) return;
        if (micSession.isMuted()) return;
        markSpeechCandidateStarted();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('nomatch', () => {
        if (!acceptsRecognizerEvent()) return;
        resolveSpeechCandidateFalseAlarm();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
        if (!acceptsRecognizerEvent()) return;
        const results = Array.isArray(event?.results) ? event.results : [];
        const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
        markAudioStarted();
        if (!transcript) return;
        if (micSession.isMuted()) return;
        markSpeechCandidateStarted();

        if (event?.isFinal) {
          nextHandle.finalSegments.push(transcript);
          nextHandle.latestInterimText = '';
          finalizeTranscriptEndpoint(committedTranscript());
        } else {
          nextHandle.latestInterimText = transcript;
          safelyNotifyObserver(() => sink.onPartial(transcript));
        }
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        if (!acceptsRecognizerEvent()) return;
        nextHandle.acceptsRecognizerEvents = false;
        let shouldPublishTerminalFailure = false;
        try {
          if (!nextHandle.terminalResult) {
            nextHandle.terminalResult = resolveTerminalResult();
            shouldPublishTerminalFailure = 'error' in nextHandle.terminalResult;
          }
          if (!committedTranscript()) {
            resolveSpeechCandidateFalseAlarm();
          }
        } catch {
          // Observer failures cannot strand the provider-owned native lease.
        } finally {
          void releaseAudioSessionLease(nextHandle).catch(() => {}).then(() => {
            const terminalResult = nextHandle.terminalResult;
            if (!shouldPublishTerminalFailure || !terminalResult || !('error' in terminalResult)) {
              return;
            }
            safelyNotifyObserver(() => sink.onError(terminalResult.error));
          });
          nextHandle.resolveEnd();
        }
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('error', (event: any) => {
        if (!acceptsRecognizerEvent()) return;
        nextHandle.acceptsRecognizerEvents = false;
        const reason = normalizeNonEmptyString(event?.error) ?? 'device_stt_error';
        resolveSpeechCandidateFalseAlarm();
        const finalText = committedTranscript();
        const providerError = createVoiceMachineError({ kind: 'provider_error', reason });
        // A no-speech/speech-timeout event is only a benign empty result when
        // the product already asked the recognizer to stop. When the provider
        // terminates an otherwise active capture on its own, the Voice owner
        // must receive the failure instead of continuing with a dead recognizer.
        const isExpectedEmptyStop = nextHandle.recognizerStopRequested
          && isEmptyRecognitionTerminalReason(reason);
        const shouldPublishProviderError = !finalText && !isExpectedEmptyStop;
        nextHandle.terminalResult ??= finalText
          ? { finalText }
          : shouldPublishProviderError
            ? { error: providerError }
            : { finalText: '' };
        void cleanupHandle(nextHandle).catch(() => {}).then(() => {
          nextHandle.resolveEnd();
          if (shouldPublishProviderError) {
            safelyNotifyObserver(() => sink.onError(providerError));
          }
        });
      })
    );

    // Honor the D8 abort signal mid-flight. The entry guard only covers
    // pre-start abort; once `ExpoSpeechRecognitionModule.start()` is running,
    // firing the signal must stop the recognizer promptly. Mirrors the
    // AbortController bridge in SherpaStreamingSttController; the listener is
    // detached on stop()/abort so it does not leak on the (possibly long-lived)
    // signal.
    const onAbort = () => {
      if (!acceptsRecognizerEvent()) return;
      nextHandle.acceptsRecognizerEvents = false;
      nextHandle.terminalResult ??= {
        error: createVoiceMachineError({ kind: 'turn_aborted', reason: 'turn_aborted' }),
      };
      resolveSpeechCandidateFalseAlarm();
      stopRecognizerOnce();
      void cleanupHandle(nextHandle).catch(() => {});
      nextHandle.resolveEnd();
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      nextHandle.abortCleanup = () => {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
      };
    }

    // The signal may have aborted during async setup (permissions, exclusive
    // lease acquisition, or web VAD start) before the listener attached above;
    // do not start a recognizer we
    // were already told to abort.
    if (signal?.aborted || reservation.cancelled) {
      nextHandle.acceptsRecognizerEvents = false;
      if (signal?.aborted) {
        nextHandle.terminalResult ??= {
          error: createVoiceMachineError({ kind: 'turn_aborted', reason: 'turn_aborted' }),
        };
      }
      await cleanupHandle(nextHandle);
      nextHandle.resolveEnd();
      return;
    }

    const settings = deps.getSettings();
    const language = typeof settings?.voice?.assistantLanguage === 'string' && settings.voice.assistantLanguage.trim()
      ? settings.voice.assistantLanguage.trim()
      : undefined;

      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        maxAlternatives: 1,
        continuous: resolveDeviceContinuousRecognition({ platformOs, isDomRuntime: dom }),
      } as any);
    } catch (error) {
      const startError = createVoiceMachineError({
        kind: 'provider_error',
        reason: 'device_stt_start_failed',
      });
      safelyNotifyObserver(() => sink.onError(startError));
      nextHandle.resolveEnd();
      try {
        await cleanupHandle(nextHandle);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Device STT startup and audio-session release both failed.');
      }
      throw error;
    }
    } finally {
      try {
        signal?.removeEventListener('abort', onSetupAbort);
      } catch {
        // ignore
      }
      if (startReservation === reservation) startReservation = null;
      reservation.resolveSettled();
    }
  };

  const stop = async () => {
    const pendingStart = startReservation;
    if (pendingStart) {
      pendingStart.cancel();
      await pendingStart.settled;
    }
    const current = handle;
    if (!current) {
      const result = completedResult ?? { finalText: '' };
      completedResult = null;
      return result;
    }
    if (!current.recognizerStopRequested) {
      current.recognizerStopRequested = true;
      try {
        current.module?.stop?.();
      } catch {
        // ignore
      }
    }

    await Promise.race([current.endPromise, new Promise<void>((resolve) => setTimeout(resolve, stopTimeoutMs))]);

    current.terminalResult ??= (() => {
      const finalText = current.finalSegments.join(' ').trim();
      if (finalText) return { finalText };
      if (current.latestInterimText) {
        return {
          error: createVoiceMachineError({
            kind: 'provider_error',
            reason: 'device_stt_finalization_failed',
          }),
        };
      }
      return { finalText: '' };
    })();
    const result = current.terminalResult;
    await cleanupHandle(current);
    completedResult = null;

    return result;
  };

  return {
    start,
    stop,
  };
}
