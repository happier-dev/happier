import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import { normalizeTurnEndpointPolicy } from '@/voice/input/TurnEndpointDetector';
import {
  createTurnEndpointController,
  type TurnEndpointController,
  type TurnEndpointSignal,
} from '@/voice/runtime/input/TurnEndpointController';
import {
  createNativeVadController,
  type NativeVadController,
} from '@/voice/runtime/input/NativeVadController';
import {
  createWebVadController,
  type WebVadController,
} from '@/voice/runtime/input/WebVadController';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { Platform } from 'react-native';

type DeviceSttStatePatch = {
  controlSessionId: string;
  reason: string;
};

type DeviceSttHandle = {
  sessionId: string;
  transcript: string;
  module: any;
  resolveEnd: () => void;
  endPromise: Promise<void>;
  subscriptions: { remove(): void }[];
};

export type DeviceSttController = Readonly<{
  start: (sessionId: string, micSession: MicSession) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
}>;

export function createDeviceSttController(deps: {
  onCaptureStarted: (controlSessionId: string) => void;
  onCaptureError: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  onEndpointSignal?: (signal: TurnEndpointSignal) => void;
  endpointController?: TurnEndpointController;
  nativeVadController?: NativeVadController;
  webVadController?: WebVadController;
}): DeviceSttController {
  let handle: DeviceSttHandle | null = null;

  const isDomRuntime = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';
  const normalizeSessionId = (sessionId: string | null | undefined): string | null => normalizeNonEmptyString(sessionId);

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

  const start = async (sessionId: string, micSession: MicSession) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return;
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
      deps.onCaptureError({ controlSessionId: normalizedSessionId, reason: 'device_stt_unavailable' });
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
      } catch {
        // Permission request best-effort.
      }
    }

    await micSession.ensureActive();

    cleanupListeners();
    endpointController.clearSession();
    await nativeVadController.stopSession();
    await webVadController.stopSession();

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    const nextHandle: DeviceSttHandle = {
      sessionId: normalizedSessionId,
      transcript: '',
      module: ExpoSpeechRecognitionModule,
      resolveEnd: () => resolveEnd?.(),
      endPromise,
      subscriptions: [],
    };

    handle = nextHandle;
    endpointController.startSession(normalizedSessionId);
    const handsFreeTurnEndpointPolicy = resolveHandsFreeTurnEndpointPolicy();
    const usesFallbackTurnCapture = Platform.OS === 'web' || isDomRuntime();
    const usesNativeVad = usesFallbackTurnCapture
      ? false
      : await nativeVadController.startSession({
        sessionId: normalizedSessionId,
        minSpeechMs: handsFreeTurnEndpointPolicy.minSpeechMs,
        redemptionMs: handsFreeTurnEndpointPolicy.silenceMs,
      });
    const usesWebVad = Platform.OS === 'web' && await webVadController.startSession({
      sessionId: normalizedSessionId,
      minSpeechMs: handsFreeTurnEndpointPolicy.minSpeechMs,
      redemptionMs: handsFreeTurnEndpointPolicy.silenceMs,
    });
    const usesVad = usesNativeVad || usesWebVad;

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
        const results = Array.isArray(event?.results) ? event.results : [];
        const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
        if (!transcript) return;

        nextHandle.transcript = transcript;
        if (event?.isFinal && !usesVad) {
          endpointController.signalHeuristicTranscriptFinalized({
            sessionId: normalizedSessionId,
            transcript,
            policy: handsFreeTurnEndpointPolicy,
          });
        }
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('end', () => {
        nextHandle.resolveEnd();
      })
    );

    nextHandle.subscriptions.push(
      ExpoSpeechRecognitionModule.addListener('error', () => {
        nextHandle.resolveEnd();
      })
    );

    const settings = deps.getSettings();
    const language = typeof settings?.voice?.assistantLanguage === 'string' && settings.voice.assistantLanguage.trim()
      ? settings.voice.assistantLanguage.trim()
      : undefined;

    try {
      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        maxAlternatives: 1,
        continuous: !usesFallbackTurnCapture,
      } as any);
    } catch (error) {
      handle = null;
      endpointController.clearSession(normalizedSessionId);
      await nativeVadController.stopSession(normalizedSessionId);
      await webVadController.stopSession(normalizedSessionId);
      deps.onCaptureError({ controlSessionId: normalizedSessionId, reason: 'device_stt_start_failed' });
      throw error;
    }

    deps.onCaptureStarted(normalizedSessionId);
  };

  const stop = async (sessionId: string): Promise<string> => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!handle || !normalizedSessionId || handle.sessionId !== normalizedSessionId) {
      return '';
    }

    endpointController.clearSession(normalizedSessionId);
    const stopNativeVad = nativeVadController.stopSession(normalizedSessionId);
    const stopWebVad = webVadController.stopSession(normalizedSessionId);

    try {
      handle.module?.stop?.();
    } catch {
      // ignore
    }

    await Promise.race([handle.endPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);

    const text = handle.transcript.trim();
    const subscriptions = handle.subscriptions;
    handle = null;

    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }
    await stopNativeVad;
    await stopWebVad;

    return text;
  };

  return {
    start,
    stop,
  };
}
