import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import { normalizeTurnEndpointPolicy } from '@/voice/runtime/input/TurnEndpointDetector';
import {
  createTurnEndpointController, type TurnEndpointController, type TurnEndpointSignal, } from '@/voice/runtime/input/TurnEndpointController';
import {
  createNativeVadController, type NativeVadController, } from '@/voice/runtime/input/NativeVadController';
import {
  createWebVadController, type WebVadController, } from '@/voice/runtime/input/WebVadController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { Platform } from 'react-native';

import type { SttController, SttStartParams } from './sttController';

type DeviceSttHandle = {
  sessionId: string;
  transcript: string;
  module: any;
  resolveEnd: () => void;
  endPromise: Promise<void>;
  subscriptions: { remove(): void }[];
  audioStarted: boolean;
  /** Detaches the D8 abort listener; idempotent and safe after teardown. */
  abortCleanup: () => void;
  recognizerStopRequested: boolean;
};

export type DeviceSttController = SttController;

export type CreateDeviceSttControllerDeps = {
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  endpointController?: TurnEndpointController;
  nativeVadController?: NativeVadController;
  webVadController?: WebVadController;
  /** Stop wait before forcing finalize; defaults to the recognizer end timeout. */
  stopTimeoutMs?: number;
};

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

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

  const isDomRuntime = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';
  const normalizeSessionId = (sessionId: string | null | undefined): string | null => normalizeNonEmptyString(sessionId);
  const stopTimeoutMs = typeof deps.stopTimeoutMs === 'number' && deps.stopTimeoutMs >= 0
    ? deps.stopTimeoutMs
    : DEFAULT_STOP_TIMEOUT_MS;

  const resolveAdapterSettings = () => {
    const settings = deps.getSettings();
    const voice = settings?.voice ?? null;
    const providerId = normalizeNonEmptyString(voice?.providerId);
    return providerId === 'local_direct'
      ? voice?.adapters?.local_direct
      : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;
  };

  const endpointController = deps.endpointController ?? createTurnEndpointController({
    onSignal: (signal) => {
      deps.onEndpointSignal?.(signal);
    },
  });
  const nativeVadController = deps.nativeVadController ?? createNativeVadController({
    onEndpointSignal: (signal) => {
      deps.onEndpointSignal?.(signal);
    },
  });
  const webVadController = deps.webVadController ?? createWebVadController({
    onEndpointSignal: (signal) => {
      deps.onEndpointSignal?.(signal);
    },
  });

  const resolveHandsFreeTurnEndpointPolicy = () => {
    const adapter = resolveAdapterSettings();
    return normalizeTurnEndpointPolicy({
      silenceMs: adapter?.handsFree?.endpointing?.silenceMs ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
      minSpeechMs: adapter?.handsFree?.endpointing?.minSpeechMs ?? VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
    });
  };

  const cleanupListeners = () => {
    const subscriptions = handle?.subscriptions ?? [];
    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }
  };

  const start = async ({ micSession, sink, signal }: SttStartParams) => {
    if (signal?.aborted) {
      return;
    }
    if (!micSession) {
      throw new Error('mic_session_required');
    }

    const microphonePermission = await requestMicrophonePermission();
    if (!microphonePermission.granted) {
      showMicrophonePermissionDeniedAlert(microphonePermission.canAskAgain);
      throw new Error('mic_permission_denied');
    }

    const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');

    if (typeof ExpoSpeechRecognitionModule?.isRecognitionAvailable === 'function' && !ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'device_stt_unavailable' }));
      return;
    }

    // `expo-speech-recognition` logs noisy "not supported on web" warnings for this call.
    // Prefer DOM detection over Platform.OS so web builds remain resilient even if Platform.OS is surprising.
    if (Platform.OS !== 'web' && !isDomRuntime()) {
      try {
        const permissionsResponse = await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        if (permissionsResponse && permissionsResponse.granted === false) {
          throw new Error('mic_permission_denied');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'mic_permission_denied') {
          throw error;
        }
        // Permission request best-effort otherwise.
      }
    }

    // Single canonical acquisition for the turn: the recognizer reuses the
    // already-active capture session (WebVAD also consumes this same stream).
    await micSession.ensureActive();

    cleanupListeners();
    endpointController.clearSession();
    await nativeVadController.stopSession();
    await webVadController.stopSession();

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    // Capture a stable session key for guards; the runtime owner correlates the
    // active capture, so the controller keys its own handle off a synthetic id.
    const sessionKey = normalizeSessionId(`device-${Date.now()}-${Math.random()}`) ?? 'device-capture';

    const nextHandle: DeviceSttHandle = {
      sessionId: sessionKey,
      transcript: '',
      module: ExpoSpeechRecognitionModule,
      resolveEnd: () => resolveEnd?.(),
      endPromise,
      subscriptions: [],
      audioStarted: false,
      abortCleanup: () => {},
      recognizerStopRequested: false,
    };

    handle = nextHandle;
    endpointController.startSession(sessionKey);
    const handsFreeTurnEndpointPolicy = resolveHandsFreeTurnEndpointPolicy();
    const platformOs = Platform.OS;
    const dom = isDomRuntime();
    const usesFallbackTurnCapture = platformOs === 'web' || dom;
    const usesNativeVad = usesFallbackTurnCapture
      ? false
      : await nativeVadController.startSession({
        sessionId: sessionKey,
        minSpeechMs: handsFreeTurnEndpointPolicy.minSpeechMs,
        redemptionMs: handsFreeTurnEndpointPolicy.silenceMs,
      });
    const usesWebVad = platformOs === 'web' && await webVadController.startSession({
      sessionId: sessionKey,
      minSpeechMs: handsFreeTurnEndpointPolicy.minSpeechMs,
      redemptionMs: handsFreeTurnEndpointPolicy.silenceMs,
      // Drive WebVAD off the canonical capture stream + shared AudioContext so
      // web hands-free runs on one mic acquisition instead of a self-opened one.
      micSession,
    });
    const usesVad = usesNativeVad || usesWebVad;

    const markAudioStarted = () => {
      if (!handle || handle.sessionId !== sessionKey || handle.audioStarted) {
        return;
      }
      handle.audioStarted = true;
      sink.onAudioStarted();
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

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('audiostart', () => {
        markAudioStarted();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
        const results = Array.isArray(event?.results) ? event.results : [];
        const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
        markAudioStarted();
        if (!transcript) return;

        nextHandle.transcript = transcript;
        if (event?.isFinal) {
          sink.onFinal(transcript);
          sink.onEndpoint('silence');
          endpointController.signalHeuristicTranscriptFinalized({
            sessionId: sessionKey,
            transcript,
            policy: handsFreeTurnEndpointPolicy,
          });
        } else {
          sink.onPartial(transcript);
        }
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        nextHandle.resolveEnd();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('error', (event: any) => {
        const reason = normalizeNonEmptyString(event?.error) ?? 'device_stt_error';
        sink.onError(createVoiceMachineError({ kind: 'provider_error', reason }));
        nextHandle.resolveEnd();
      })
    );

    // Honor the D8 abort signal mid-flight. The entry guard only covers
    // pre-start abort; once `ExpoSpeechRecognitionModule.start()` is running,
    // firing the signal must stop the recognizer promptly. Mirrors the
    // AbortController bridge in SherpaStreamingSttController; the listener is
    // detached on stop()/abort so it does not leak on the (possibly long-lived)
    // signal.
    const onAbort = () => {
      stopRecognizerOnce();
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

    // The signal may have aborted during async setup (permissions, ensureActive,
    // VAD start) before the listener attached above; do not start a recognizer we
    // were already told to abort.
    if (signal?.aborted) {
      nextHandle.abortCleanup();
      try {
        nextHandle.subscriptions.forEach((subscription) => subscription.remove());
      } catch {
        // ignore
      }
      handle = null;
      endpointController.clearSession(sessionKey);
      await nativeVadController.stopSession(sessionKey);
      await webVadController.stopSession(sessionKey);
      nextHandle.resolveEnd();
      return;
    }

    const settings = deps.getSettings();
    const language = typeof settings?.voice?.assistantLanguage === 'string' && settings.voice.assistantLanguage.trim()
      ? settings.voice.assistantLanguage.trim()
      : undefined;

    try {
      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        maxAlternatives: 1,
        continuous: resolveDeviceContinuousRecognition({ platformOs, isDomRuntime: dom }),
      } as any);
    } catch (error) {
      nextHandle.abortCleanup();
      handle = null;
      endpointController.clearSession(sessionKey);
      await nativeVadController.stopSession(sessionKey);
      await webVadController.stopSession(sessionKey);
      sink.onError(createVoiceMachineError({ kind: 'provider_error', reason: 'device_stt_start_failed' }));
      throw error;
    }
  };

  const stop = async () => {
    const current = handle;
    if (!current) {
      return { finalText: '' };
    }
    const sessionKey = current.sessionId;

    endpointController.clearSession(sessionKey);
    const stopNativeVad = nativeVadController.stopSession(sessionKey);
    const stopWebVad = webVadController.stopSession(sessionKey);

    if (!current.recognizerStopRequested) {
      current.recognizerStopRequested = true;
      try {
        current.module?.stop?.();
      } catch {
        // ignore
      }
    }

    await Promise.race([current.endPromise, new Promise<void>((resolve) => setTimeout(resolve, stopTimeoutMs))]);

    const text = current.transcript.trim();
    const subscriptions = current.subscriptions;
    handle = null;
    current.abortCleanup();

    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }
    await stopNativeVad;
    await stopWebVad;

    return { finalText: text };
  };

  return {
    start,
    stop,
  };
}
